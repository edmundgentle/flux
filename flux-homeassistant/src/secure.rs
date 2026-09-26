//! Encrypted request envelopes for the LAN transport.
//!
//! LAN traffic is plain HTTP, so the access token must never travel on it. Instead both sides
//! derive AES-256-GCM keys from the token and exchange whole requests and responses as sealed
//! envelopes. The GCM tag authenticates the payload, so no separate signature is needed, and
//! the sequence number that forms the nonce also drives replay rejection.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::BTreeMap;

/// Carries the session's public key id so the server can find the right key before decrypting.
pub const KEY_ID_HEADER: &str = "x-flux-key-id";

const INFO_CLIENT_TO_SERVER: &[u8] = b"flux-secure-v1-client-to-server";
const INFO_SERVER_TO_CLIENT: &[u8] = b"flux-secure-v1-server-to-client";

#[derive(Debug, Serialize, Deserialize)]
pub struct SecureRequestHeader {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SecureResponseHeader {
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// Directional keys derived from the access token. Separating the two directions stops a
/// captured response from being replayed back at the server as if it were a request.
pub struct SessionKeys {
    pub client_to_server: [u8; 32],
    pub server_to_client: [u8; 32],
}

pub fn derive_keys(token: &str, key_id: &str) -> SessionKeys {
    let hkdf = Hkdf::<Sha256>::new(Some(key_id.as_bytes()), token.as_bytes());
    let mut client_to_server = [0u8; 32];
    let mut server_to_client = [0u8; 32];
    // Failure is only possible for absurd output lengths, which 32 bytes is not.
    hkdf.expand(INFO_CLIENT_TO_SERVER, &mut client_to_server).expect("HKDF expand failed");
    hkdf.expand(INFO_SERVER_TO_CLIENT, &mut server_to_client).expect("HKDF expand failed");
    SessionKeys { client_to_server, server_to_client }
}

/// A sequence number is only ever used once per session, so deriving the nonce from it
/// guarantees GCM's never-reuse-a-nonce requirement without tracking extra state.
fn nonce_for(seq: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&seq.to_be_bytes());
    nonce
}

fn frame(header: &[u8], body: &[u8]) -> Vec<u8> {
    let mut plaintext = Vec::with_capacity(4 + header.len() + body.len());
    plaintext.extend_from_slice(&(header.len() as u32).to_be_bytes());
    plaintext.extend_from_slice(header);
    plaintext.extend_from_slice(body);
    plaintext
}

fn unframe(plaintext: &[u8]) -> Result<(&[u8], &[u8]), String> {
    if plaintext.len() < 4 {
        return Err("Envelope payload is truncated".to_string());
    }
    let header_len = u32::from_be_bytes([plaintext[0], plaintext[1], plaintext[2], plaintext[3]]) as usize;
    if plaintext.len() < 4 + header_len {
        return Err("Envelope header length is out of range".to_string());
    }
    Ok((&plaintext[4..4 + header_len], &plaintext[4 + header_len..]))
}

fn seal(key: &[u8; 32], key_id: &str, seq: u64, header: &[u8], body: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = nonce_for(seq);
    cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: &frame(header, body), aad: key_id.as_bytes() },
        )
        .map_err(|_| "Failed to seal envelope".to_string())
}

fn open(key: &[u8; 32], key_id: &str, seq: u64, ciphertext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = nonce_for(seq);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: ciphertext, aad: key_id.as_bytes() },
        )
        .map_err(|_| "Envelope failed authentication".to_string())?;
    let (header, body) = unframe(&plaintext)?;
    Ok((header.to_vec(), body.to_vec()))
}

/// Splits the clear sequence number from the sealed remainder of a request envelope. The
/// sequence number is unauthenticated here, but it derives the nonce, so altering it simply
/// makes decryption fail.
pub fn split_sequence(envelope: &[u8]) -> Result<(u64, &[u8]), String> {
    if envelope.len() < 8 {
        return Err("Envelope is too short to contain a sequence number".to_string());
    }
    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&envelope[..8]);
    Ok((u64::from_be_bytes(seq_bytes), &envelope[8..]))
}

pub fn open_request(
    keys: &SessionKeys,
    key_id: &str,
    seq: u64,
    ciphertext: &[u8],
) -> Result<(SecureRequestHeader, Vec<u8>), String> {
    let (header, body) = open(&keys.client_to_server, key_id, seq, ciphertext)?;
    let header: SecureRequestHeader =
        serde_json::from_slice(&header).map_err(|e| format!("Malformed envelope header: {}", e))?;
    Ok((header, body))
}

pub fn seal_response(
    keys: &SessionKeys,
    key_id: &str,
    seq: u64,
    header: &SecureResponseHeader,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    let header = serde_json::to_vec(header)
        .map_err(|e| format!("Failed to serialize envelope header: {}", e))?;
    seal(&keys.server_to_client, key_id, seq, &header, body)
}

/// Sliding-window replay protection, as used by IPsec and WireGuard: a high-water mark plus a
/// bitmap of recently accepted sequence numbers. Fixed size, so it persists cheaply and never
/// grows, and it tolerates the out-of-order arrival that concurrent requests produce.
pub const REPLAY_WINDOW: u64 = 64;

/// Sequence numbers accepted shortly before a restart may not have reached disk, so on load the
/// high-water mark jumps ahead by this much rather than risking their reuse.
pub const REPLAY_RESTART_MARGIN: u64 = 1024;

#[derive(Debug, Clone, Copy, Default)]
pub struct ReplayWindow {
    pub high: u64,
    pub mask: u64,
}

impl ReplayWindow {
    /// Accepts `seq` exactly once, advancing the window. Returns `false` for anything already
    /// seen or older than the window.
    pub fn accept(&mut self, seq: u64) -> bool {
        if seq > self.high {
            let shift = seq - self.high;
            self.mask = if shift >= REPLAY_WINDOW { 0 } else { self.mask << shift };
            self.mask |= 1;
            self.high = seq;
            return true;
        }
        let behind = self.high - seq;
        if behind >= REPLAY_WINDOW {
            return false;
        }
        let bit = 1u64 << behind;
        if self.mask & bit != 0 {
            return false;
        }
        self.mask |= bit;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_request_round_trips() {
        let keys = derive_keys("token-abc", "key-1");
        let header = serde_json::to_vec(&SecureRequestHeader {
            method: "GET".to_string(),
            path: "/api/search".to_string(),
            query: BTreeMap::from([("q".to_string(), "holiday".to_string())]),
            headers: BTreeMap::new(),
        })
        .unwrap();

        let sealed = seal(&keys.client_to_server, "key-1", 7, &header, b"body-bytes").unwrap();
        let (decoded, body) = open_request(&keys, "key-1", 7, &sealed).unwrap();

        assert_eq!(decoded.path, "/api/search");
        assert_eq!(decoded.query.get("q").unwrap(), "holiday");
        assert_eq!(body, b"body-bytes");
    }

    #[test]
    fn tampering_with_the_payload_is_rejected() {
        let keys = derive_keys("token-abc", "key-1");
        let header = serde_json::to_vec(&SecureRequestHeader {
            method: "GET".to_string(),
            path: "/api/search".to_string(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
        })
        .unwrap();

        let mut sealed = seal(&keys.client_to_server, "key-1", 1, &header, b"body").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;

        assert!(open_request(&keys, "key-1", 1, &sealed).is_err());
    }

    #[test]
    fn a_different_token_cannot_open_the_envelope() {
        let sender = derive_keys("token-abc", "key-1");
        let attacker = derive_keys("token-xyz", "key-1");
        let header = serde_json::to_vec(&SecureRequestHeader {
            method: "GET".to_string(),
            path: "/api/search".to_string(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
        })
        .unwrap();

        let sealed = seal(&sender.client_to_server, "key-1", 1, &header, b"body").unwrap();

        assert!(open_request(&attacker, "key-1", 1, &sealed).is_err());
    }

    /// Wire-format compatibility with the TypeScript SDK. Regenerate with:
    /// `node --input-type=module -e "const {SecureChannel}=await import('./dist/secure.js'); ..."`
    #[test]
    fn opens_an_envelope_sealed_by_the_typescript_sdk() {
        let envelope = hex::decode(concat!(
            "000000000000000749613706a76d2fa470c297564538f1dbe071c86f4b48af004405d29302ed2827d14a4",
            "9de722c6ef7fd9b87897b5ebc2308ff7c31ceb8b898ca1b7c4ba116b8fcbee7ad67a29b756b16d5f21f17",
            "f12cf66c4f02e6717e9fe12c9831431fdddf25a5f1084a8bef4920"
        ))
        .unwrap();

        let keys = derive_keys("token-abc", "key-1");
        let (seq, ciphertext) = split_sequence(&envelope).unwrap();
        let (header, body) = open_request(&keys, "key-1", seq, ciphertext).unwrap();

        assert_eq!(seq, 7);
        assert_eq!(header.method, "GET");
        assert_eq!(header.path, "/api/search");
        assert_eq!(header.query.get("q").unwrap(), "holiday");
        assert_eq!(body, b"body-bytes");
    }

    #[test]
    fn replaying_a_sequence_number_is_rejected() {
        let mut window = ReplayWindow::default();

        assert!(window.accept(1));
        assert!(window.accept(2));
        assert!(!window.accept(1));
        assert!(!window.accept(2));
    }

    #[test]
    fn out_of_order_arrivals_inside_the_window_are_accepted_once() {
        let mut window = ReplayWindow::default();

        assert!(window.accept(10));
        assert!(window.accept(8));
        assert!(window.accept(9));
        assert!(!window.accept(8));
        // Older than the window entirely.
        assert!(window.accept(200));
        assert!(!window.accept(10));
    }
}
