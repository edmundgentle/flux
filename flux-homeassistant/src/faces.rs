//! Face grouping ("people"), labelling against contacts or free-text names, and "are these the
//! same person?" suggestions, built on the Facenet512 embeddings produced by `detect.rs`.
//!
//! State is kept per photo owner in `<index_root>/faces/<user key>.json`. Every face belongs to
//! exactly one person; a person without a name is simply an unlabelled group.

use crate::detect::FaceDetection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Cosine similarity at or above which a new face joins an existing person automatically.
/// Deliberately conservative: a wrong auto-merge is worse than an extra suggestion.
const JOIN_SIMILARITY: f32 = 0.62;
/// Cosine similarity at or above which two people are offered as a "same person?" suggestion.
const SUGGEST_SIMILARITY: f32 = 0.45;
/// Similarity above which a face found when re-indexing a photo is treated as the same face.
const SAME_FACE_SIMILARITY: f32 = 0.9;
const MAX_CONTACT_FILE_BYTES: u64 = 2 * 1024 * 1024;

type FaceResult<T> = Result<T, (u16, String)>;

fn bad_request(message: &str) -> (u16, String) {
    (400, message.to_string())
}

fn not_found(message: &str) -> (u16, String) {
    (404, message.to_string())
}

fn normalize(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|v| *v /= norm);
    }
    vector
}

/// Both inputs are L2-normalized, so the dot product is the cosine similarity.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn ordered_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Embeddings are stored as base64 int8 (scaled per vector) - only their direction matters.
mod embedding_codec {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(clippy::ptr_arg)]
    pub fn serialize<S: Serializer>(embedding: &Vec<f32>, serializer: S) -> Result<S::Ok, S::Error> {
        let max = embedding.iter().fold(0f32, |max, v| max.max(v.abs()));
        let scale = if max > 0.0 { 127.0 / max } else { 0.0 };
        let bytes: Vec<u8> = embedding
            .iter()
            .map(|v| (v * scale).round().clamp(-127.0, 127.0) as i8 as u8)
            .collect();
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<f32>, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(serde::de::Error::custom)?;
        Ok(super::normalize(
            bytes.into_iter().map(|b| b as i8 as f32).collect(),
        ))
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct FaceRecord {
    id: String,
    path: String,
    /// `[x, y, width, height]`, normalized to the upright image.
    bbox: [f32; 4],
    #[serde(with = "embedding_codec")]
    embedding: Vec<f32>,
    person_id: String,
    /// Set once the user places this face by hand.
    #[serde(default)]
    locked: bool,
    /// People the user said this face is not.
    #[serde(default)]
    rejected: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Person {
    id: String,
    name: Option<String>,
    contact_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct PhotoRecord {
    width: u32,
    height: u32,
    date_created: i64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct UserFaces {
    #[serde(default)]
    faces: Vec<FaceRecord>,
    #[serde(default)]
    people: HashMap<String, Person>,
    /// Every analyzed photo's dimensions and date, including photos with no faces.
    #[serde(default)]
    photos: HashMap<String, PhotoRecord>,
    /// Pairs of people the user said are different people.
    #[serde(default)]
    rejected_pairs: HashSet<(String, String)>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ContactSummary {
    pub id: String,
    pub name: String,
    pub path: String,
}

impl UserFaces {
    fn new_person(&mut self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.people.insert(
            id.clone(),
            Person {
                id: id.clone(),
                name: None,
                contact_id: None,
            },
        );
        id
    }

    fn centroids(&self) -> HashMap<String, Vec<f32>> {
        let mut sums: HashMap<String, Vec<f32>> = HashMap::new();
        for face in &self.faces {
            let sum = sums
                .entry(face.person_id.clone())
                .or_insert_with(|| vec![0.0; face.embedding.len()]);
            if sum.len() == face.embedding.len() {
                for (total, value) in sum.iter_mut().zip(&face.embedding) {
                    *total += value;
                }
            }
        }
        sums.into_iter()
            .map(|(id, sum)| (id, normalize(sum)))
            .collect()
    }

    fn faces_by_person(&self) -> HashMap<&str, Vec<&FaceRecord>> {
        let mut grouped: HashMap<&str, Vec<&FaceRecord>> = HashMap::new();
        for face in &self.faces {
            grouped.entry(face.person_id.as_str()).or_default().push(face);
        }
        grouped
    }

    /// Drops people left without faces and any references to them.
    fn prune_people(&mut self) {
        let used: HashSet<String> = self.faces.iter().map(|f| f.person_id.clone()).collect();
        self.people.retain(|id, _| used.contains(id));
        let people = &self.people;
        self.rejected_pairs
            .retain(|(a, b)| people.contains_key(a) && people.contains_key(b));
        for face in &mut self.faces {
            face.rejected.retain(|id| people.contains_key(id));
        }
    }

    fn sync_photo(&mut self, path: &str, photo: PhotoRecord, detections: Vec<FaceDetection>) -> bool {
        let mut changed = self.photos.get(path) != Some(&photo);
        self.photos.insert(path.to_string(), photo);

        // Re-indexing the same photo must keep existing faces (and their labels) in place.
        let mut existing: Vec<usize> = (0..self.faces.len())
            .filter(|&i| self.faces[i].path == path)
            .collect();
        let mut unmatched = Vec::new();
        for detection in detections {
            let best = existing
                .iter()
                .enumerate()
                .map(|(slot, &i)| (slot, cosine(&self.faces[i].embedding, &detection.embedding)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            match best {
                Some((slot, similarity)) if similarity >= SAME_FACE_SIMILARITY => {
                    let i = existing.swap_remove(slot);
                    if self.faces[i].bbox != detection.bbox {
                        self.faces[i].bbox = detection.bbox;
                        changed = true;
                    }
                }
                _ => unmatched.push(detection),
            }
        }

        if !existing.is_empty() {
            let stale: HashSet<String> = existing.iter().map(|&i| self.faces[i].id.clone()).collect();
            self.faces.retain(|face| !stale.contains(&face.id));
            changed = true;
        }

        if !unmatched.is_empty() {
            let centroids = self.centroids();
            // Two faces in one photo are never the same person.
            let mut taken: HashSet<String> = self
                .faces
                .iter()
                .filter(|face| face.path == path)
                .map(|face| face.person_id.clone())
                .collect();
            for detection in unmatched {
                let person_id = centroids
                    .iter()
                    .filter(|(id, _)| !taken.contains(*id))
                    .map(|(id, centroid)| (id, cosine(centroid, &detection.embedding)))
                    .filter(|(_, similarity)| *similarity >= JOIN_SIMILARITY)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(id, _)| id.clone())
                    .unwrap_or_else(|| self.new_person());
                taken.insert(person_id.clone());
                self.faces.push(FaceRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: path.to_string(),
                    bbox: detection.bbox,
                    embedding: normalize(detection.embedding),
                    person_id,
                    locked: false,
                    rejected: Vec::new(),
                });
            }
            changed = true;
        }

        if changed {
            self.prune_people();
        }
        changed
    }

    fn remove_photos(&mut self, paths: &HashSet<String>) -> bool {
        let before = (self.faces.len(), self.photos.len());
        self.faces.retain(|face| !paths.contains(&face.path));
        self.photos.retain(|path, _| !paths.contains(path));
        let changed = before != (self.faces.len(), self.photos.len());
        if changed {
            self.prune_people();
        }
        changed
    }

    /// Returns the id of the person that ends up carrying the label.
    fn label(&mut self, person_id: &str, name: Option<&str>, contact_id: Option<&str>) -> FaceResult<String> {
        if !self.people.contains_key(person_id) {
            return Err(not_found("Unknown person"));
        }
        let name = name.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        let contact_id = contact_id
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);

        // Labelling a group with an identity another group already has means they're one person.
        let duplicates: Vec<String> = self
            .people
            .values()
            .filter(|other| other.id != person_id)
            .filter(|other| {
                let same_contact = contact_id.is_some() && other.contact_id == contact_id;
                let same_name = match (&name, &other.name) {
                    (Some(a), Some(b)) => {
                        a.eq_ignore_ascii_case(b)
                            && (contact_id.is_none()
                                || other.contact_id.is_none()
                                || other.contact_id == contact_id)
                    }
                    _ => false,
                };
                same_contact || same_name
            })
            .map(|other| other.id.clone())
            .collect();

        let person = self.people.get_mut(person_id).expect("checked above");
        person.name = name;
        person.contact_id = contact_id;
        if !duplicates.is_empty() {
            self.merge(person_id, &duplicates)?;
        }
        Ok(person_id.to_string())
    }

    fn merge(&mut self, target_id: &str, source_ids: &[String]) -> FaceResult<()> {
        if !self.people.contains_key(target_id) {
            return Err(not_found("Unknown person"));
        }
        for source_id in source_ids {
            if source_id == target_id {
                continue;
            }
            let Some(source) = self.people.remove(source_id) else {
                continue;
            };
            let target = self.people.get_mut(target_id).expect("checked above");
            if target.name.is_none() && target.contact_id.is_none() {
                target.name = source.name;
                target.contact_id = source.contact_id;
            }
            for face in &mut self.faces {
                if &face.person_id == source_id {
                    face.person_id = target_id.to_string();
                }
                for rejected in &mut face.rejected {
                    if rejected == source_id {
                        *rejected = target_id.to_string();
                    }
                }
            }
            self.rejected_pairs = self
                .rejected_pairs
                .drain()
                .map(|(a, b)| {
                    let a = if &a == source_id { target_id.to_string() } else { a };
                    let b = if &b == source_id { target_id.to_string() } else { b };
                    ordered_pair(&a, &b)
                })
                .collect();
        }
        // The user just said these are one person, so drop contradicting rejections.
        self.rejected_pairs.retain(|(a, b)| a != b);
        for face in &mut self.faces {
            if face.person_id == target_id {
                face.rejected.retain(|id| id != target_id);
            }
        }
        self.prune_people();
        Ok(())
    }

    fn reject(&mut self, a: &str, b: &str) -> FaceResult<()> {
        if a == b {
            return Err(bad_request("A person cannot be rejected against themselves"));
        }
        if !self.people.contains_key(a) || !self.people.contains_key(b) {
            return Err(not_found("Unknown person"));
        }
        self.rejected_pairs.insert(ordered_pair(a, b));
        Ok(())
    }

    /// Moves a face to `person_id`, or into a new person of its own when `None`.
    fn assign(&mut self, face_id: &str, person_id: Option<&str>) -> FaceResult<String> {
        let Some(index) = self.faces.iter().position(|face| face.id == face_id) else {
            return Err(not_found("Unknown face"));
        };
        let target = match person_id {
            Some(id) if self.people.contains_key(id) => id.to_string(),
            Some(_) => return Err(not_found("Unknown person")),
            None => self.new_person(),
        };
        let face = &mut self.faces[index];
        let previous = std::mem::replace(&mut face.person_id, target.clone());
        if previous != target && !face.rejected.contains(&previous) {
            face.rejected.push(previous);
        }
        face.rejected.retain(|id| id != &target);
        face.locked = true;
        self.prune_people();
        Ok(target)
    }

    fn suggestions(&self, limit: usize) -> Vec<(String, String, f32)> {
        let centroids = self.centroids();
        let mut face_rejections: HashMap<&str, HashSet<&str>> = HashMap::new();
        let mut photos_by_person: HashMap<&str, HashSet<&str>> = HashMap::new();
        for face in &self.faces {
            face_rejections
                .entry(face.person_id.as_str())
                .or_default()
                .extend(face.rejected.iter().map(String::as_str));
            photos_by_person
                .entry(face.person_id.as_str())
                .or_default()
                .insert(face.path.as_str());
        }
        let is_named = |id: &str| {
            self.people
                .get(id)
                .map(|p| p.name.is_some() || p.contact_id.is_some())
                .unwrap_or(false)
        };

        let mut ids: Vec<&String> = centroids.keys().collect();
        ids.sort();
        let mut results = Vec::new();
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                let (a, b) = (a.as_str(), b.as_str());
                if is_named(a) && is_named(b) {
                    continue;
                }
                if self.rejected_pairs.contains(&ordered_pair(a, b))
                    || face_rejections.get(a).is_some_and(|r| r.contains(b))
                    || face_rejections.get(b).is_some_and(|r| r.contains(a))
                {
                    continue;
                }
                let appear_together = match (photos_by_person.get(a), photos_by_person.get(b)) {
                    (Some(pa), Some(pb)) => !pa.is_disjoint(pb),
                    _ => false,
                };
                if appear_together {
                    continue;
                }
                let similarity = cosine(&centroids[a], &centroids[b]);
                if similarity >= SUGGEST_SIMILARITY {
                    // Unlabelled first, so the question reads "is this <named person>?".
                    let (a, b) = if is_named(a) { (b, a) } else { (a, b) };
                    results.push((a.to_string(), b.to_string(), similarity));
                }
            }
        }
        results.sort_by(|x, y| y.2.total_cmp(&x.2));
        results.truncate(limit);
        results
    }

    fn face_view(&self, face: &FaceRecord) -> Value {
        let photo = self.photos.get(&face.path);
        json!({
            "id": face.id,
            "path": face.path,
            "box": { "x": face.bbox[0], "y": face.bbox[1], "width": face.bbox[2], "height": face.bbox[3] },
            "image_width": photo.map(|p| p.width).unwrap_or(0),
            "image_height": photo.map(|p| p.height).unwrap_or(0),
            "date_created": photo.map(|p| p.date_created).unwrap_or(0),
        })
    }

    fn display_name(&self, person: &Person, contacts: &HashMap<String, String>) -> Option<String> {
        person
            .contact_id
            .as_ref()
            .and_then(|id| contacts.get(id).cloned())
            .or_else(|| person.name.clone())
    }

    fn person_view(&self, person: &Person, faces: &[&FaceRecord], contacts: &HashMap<String, String>) -> Value {
        let photo_count = faces.iter().map(|f| f.path.as_str()).collect::<HashSet<_>>().len();
        let cover = faces
            .iter()
            .max_by(|a, b| (a.bbox[2] * a.bbox[3]).total_cmp(&(b.bbox[2] * b.bbox[3])))
            .map(|face| self.face_view(face));
        json!({
            "id": person.id,
            "name": self.display_name(person, contacts),
            "contact_id": person.contact_id,
            "face_count": faces.len(),
            "photo_count": photo_count,
            "cover": cover,
        })
    }

    fn people_view(&self, contacts: &HashMap<String, String>) -> Value {
        let grouped = self.faces_by_person();
        let mut people: Vec<(&Person, &Vec<&FaceRecord>)> = self
            .people
            .values()
            .filter_map(|person| grouped.get(person.id.as_str()).map(|faces| (person, faces)))
            .collect();
        people.sort_by(|(pa, fa), (pb, fb)| {
            let named_a = pa.name.is_some() || pa.contact_id.is_some();
            let named_b = pb.name.is_some() || pb.contact_id.is_some();
            named_b
                .cmp(&named_a)
                .then(fb.len().cmp(&fa.len()))
                .then(pa.id.cmp(&pb.id))
        });
        Value::Array(
            people
                .into_iter()
                .map(|(person, faces)| self.person_view(person, faces, contacts))
                .collect(),
        )
    }

    fn person_detail(&self, id: &str, contacts: &HashMap<String, String>) -> FaceResult<Value> {
        let person = self.people.get(id).ok_or_else(|| not_found("Unknown person"))?;
        let mut faces: Vec<&FaceRecord> = self.faces.iter().filter(|f| f.person_id == id).collect();
        faces.sort_by_key(|face| {
            std::cmp::Reverse(self.photos.get(&face.path).map(|p| p.date_created).unwrap_or(0))
        });
        let mut view = self.person_view(person, &faces, contacts);
        view["faces"] = Value::Array(faces.iter().map(|face| self.face_view(face)).collect());
        Ok(view)
    }

    fn photo_faces(&self, path: &str, contacts: &HashMap<String, String>) -> Value {
        Value::Array(
            self.faces
                .iter()
                .filter(|face| face.path == path)
                .map(|face| {
                    let mut view = self.face_view(face);
                    view["person_id"] = json!(face.person_id);
                    view["person_name"] = json!(self
                        .people
                        .get(&face.person_id)
                        .and_then(|p| self.display_name(p, contacts)));
                    view
                })
                .collect(),
        )
    }

    fn suggestions_view(&self, limit: usize, contacts: &HashMap<String, String>) -> Value {
        let grouped = self.faces_by_person();
        let view = |id: &str| {
            let person = &self.people[id];
            self.person_view(person, grouped.get(id).map(Vec::as_slice).unwrap_or(&[]), contacts)
        };
        Value::Array(
            self.suggestions(limit)
                .into_iter()
                .map(|(a, b, similarity)| {
                    json!({ "person_a": view(&a), "person_b": view(&b), "similarity": similarity })
                })
                .collect(),
        )
    }
}

#[derive(Clone)]
pub struct FaceStore {
    root: PathBuf,
    users: Arc<Mutex<HashMap<String, UserFaces>>>,
}

impl FaceStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            users: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn user_file(&self, user: &str) -> PathBuf {
        let key = Sha256::digest(user.trim().to_lowercase().as_bytes());
        self.root.join(format!("u-{:x}.json", key))
    }

    /// Runs `f` against the user's face state, persisting it when `f` reports a change.
    fn with_user<R>(
        &self,
        user: &str,
        f: impl FnOnce(&mut UserFaces) -> FaceResult<(R, bool)>,
    ) -> FaceResult<R> {
        let file = self.user_file(user);
        let key = user.trim().to_lowercase();
        let mut users = self.users.lock().unwrap_or_else(|e| e.into_inner());
        if !users.contains_key(&key) {
            let loaded = if file.exists() {
                let text = fs::read_to_string(&file)
                    .map_err(|e| (500, format!("Failed to read face data: {}", e)))?;
                // Refuse to continue on corrupt data rather than overwrite the user's labels.
                serde_json::from_str(&text)
                    .map_err(|e| (500, format!("Face data is corrupt: {}", e)))?
            } else {
                UserFaces::default()
            };
            users.insert(key.clone(), loaded);
        }
        let data = users.get_mut(&key).expect("inserted above");
        let (result, changed) = f(data)?;
        if changed {
            fs::create_dir_all(&self.root)
                .map_err(|e| (500, format!("Failed to create face data directory: {}", e)))?;
            let bytes = serde_json::to_vec(&*data)
                .map_err(|e| (500, format!("Failed to encode face data: {}", e)))?;
            let temp = file.with_extension("json.tmp");
            fs::write(&temp, bytes)
                .and_then(|_| fs::rename(&temp, &file))
                .map_err(|e| (500, format!("Failed to save face data: {}", e)))?;
        }
        Ok(result)
    }

    pub fn sync_photo(
        &self,
        owner: &str,
        path: &str,
        dimensions: (u32, u32),
        date_created: i64,
        detections: Vec<FaceDetection>,
    ) -> Result<(), String> {
        let photo = PhotoRecord {
            width: dimensions.0,
            height: dimensions.1,
            date_created,
        };
        self.with_user(owner, |data| Ok(((), data.sync_photo(path, photo, detections))))
            .map_err(|(_, message)| message)
    }

    pub fn remove_photo(&self, owner: &str, path: &str) -> Result<(), String> {
        let paths = HashSet::from([path.to_string()]);
        self.with_user(owner, |data| Ok(((), data.remove_photos(&paths))))
            .map_err(|(_, message)| message)
    }
}

fn contact_dirs(data_dir: &str, user: &str) -> [PathBuf; 2] {
    let root = Path::new(data_dir);
    [
        root.join(user).join("Contacts"),
        root.join("users").join(user).join("Contacts"),
    ]
}

fn unescape_vcard(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => result.push(' '),
                Some(other) => result.push(other),
                None => {}
            }
        } else {
            result.push(c);
        }
    }
    result
}

fn parse_vcard_summary(text: &str) -> (Option<String>, Option<String>) {
    let unfolded = text
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "");
    let (mut id, mut full_name, mut structured) = (None, None, None);
    for line in unfolded.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let property = key.split(';').next().unwrap_or("").trim().to_ascii_uppercase();
        match property.as_str() {
            "UID" => id = Some(unescape_vcard(value.trim())),
            "FN" => full_name = Some(unescape_vcard(value.trim())),
            "N" => {
                let parts: Vec<String> = value.split(';').map(unescape_vcard).collect();
                let get = |i: usize| parts.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
                let joined = [get(1), get(2), get(0)]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                structured = Some(joined);
            }
            _ => {}
        }
    }
    let name = full_name
        .filter(|n| !n.trim().is_empty())
        .or(structured.filter(|n| !n.is_empty()));
    (id.filter(|v| !v.is_empty()), name)
}

fn parse_json_summary(text: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return (None, None);
    };
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let composed = [field("firstName"), field("surname").or_else(|| field("lastName"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let name = field("displayName")
        .or_else(|| field("name"))
        .or_else(|| (!composed.is_empty()).then_some(composed));
    (field("id"), name)
}

/// Lightweight id + name view of the user's flux-people contacts, for labelling faces.
pub fn list_contacts(data_dir: &str, user: &str) -> Vec<ContactSummary> {
    // vCards supersede legacy JSON contacts with the same id.
    let mut by_id: HashMap<String, (bool, ContactSummary)> = HashMap::new();
    for dir in contact_dirs(data_dir, user) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_CONTACT_FILE_BYTES {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let is_vcard = ext == "vcf";
            if !is_vcard && ext != "json" {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let (id, name) = if is_vcard {
                parse_vcard_summary(&text)
            } else {
                parse_json_summary(&text)
            };
            let Some(name) = name else {
                continue;
            };
            let id = id.unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
            if by_id.get(&id).is_some_and(|(existing_is_vcard, _)| *existing_is_vcard && !is_vcard) {
                continue;
            }
            by_id.insert(
                id.clone(),
                (
                    is_vcard,
                    ContactSummary {
                        id,
                        name,
                        path: path.to_string_lossy().to_string(),
                    },
                ),
            );
        }
    }
    let mut contacts: Vec<ContactSummary> = by_id.into_values().map(|(_, c)| c).collect();
    contacts.sort_by_key(|c| c.name.to_lowercase());
    contacts
}

fn contact_names(data_dir: &str, user: &str) -> HashMap<String, String> {
    list_contacts(data_dir, user)
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect()
}

fn body_str<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn required<'a>(value: Option<&'a str>, name: &str) -> FaceResult<&'a str> {
    value
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| (400, format!("'{}' is required", name)))
}

/// Serves `/api/faces/*` for `user` - shared by the local router and the relay bridge.
/// Returns `(status, ApiResponse-shaped JSON)`.
pub fn handle_request(
    store: &FaceStore,
    data_dir: &str,
    user: &str,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    body: &Value,
) -> (u16, Value) {
    let route = path.trim_start_matches("/api/faces").trim_matches('/');
    let query_str = |key: &str| query.get(key).map(String::as_str);

    let result: FaceResult<Value> = match (method.to_ascii_uppercase().as_str(), route) {
        ("GET", "people") => {
            let contacts = contact_names(data_dir, user);
            store.with_user(user, |data| {
                // Photos deleted while the server was down would otherwise linger forever.
                let missing: HashSet<String> = data
                    .photos
                    .keys()
                    .filter(|path| !Path::new(path).is_file())
                    .cloned()
                    .collect();
                let changed = !missing.is_empty() && data.remove_photos(&missing);
                Ok((data.people_view(&contacts), changed))
            })
        }
        ("GET", "person") => required(query_str("id"), "id").and_then(|id| {
            let contacts = contact_names(data_dir, user);
            store.with_user(user, |data| Ok((data.person_detail(id, &contacts)?, false)))
        }),
        ("GET", "photo") => required(query_str("path"), "path").and_then(|photo| {
            let contacts = contact_names(data_dir, user);
            store.with_user(user, |data| Ok((data.photo_faces(photo, &contacts), false)))
        }),
        ("GET", "suggestions") => {
            let limit = query_str("limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(20)
                .clamp(1, 100);
            let contacts = contact_names(data_dir, user);
            store.with_user(user, |data| Ok((data.suggestions_view(limit, &contacts), false)))
        }
        ("GET", "contacts") => Ok(json!(list_contacts(data_dir, user))),
        ("POST", "label") => required(body_str(body, "person_id"), "person_id").and_then(|id| {
            let name = body_str(body, "name");
            let contact_id = body_str(body, "contact_id");
            store.with_user(user, |data| {
                let person_id = data.label(id, name, contact_id)?;
                Ok((json!({ "person_id": person_id }), true))
            })
        }),
        ("POST", "merge") => required(body_str(body, "target_id"), "target_id").and_then(|target| {
            let sources: Vec<String> = body
                .get("source_ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if sources.is_empty() {
                return Err(bad_request("'source_ids' must list at least one person"));
            }
            store.with_user(user, |data| {
                data.merge(target, &sources)?;
                Ok((json!({ "person_id": target }), true))
            })
        }),
        ("POST", "reject") => required(body_str(body, "person_a"), "person_a").and_then(|a| {
            let b = required(body_str(body, "person_b"), "person_b")?;
            store.with_user(user, |data| {
                data.reject(a, b)?;
                Ok((Value::Null, true))
            })
        }),
        ("POST", "assign") => required(body_str(body, "face_id"), "face_id").and_then(|face| {
            let person = body_str(body, "person_id").filter(|v| !v.trim().is_empty());
            store.with_user(user, |data| {
                let person_id = data.assign(face, person)?;
                Ok((json!({ "person_id": person_id }), true))
            })
        }),
        _ => Err(not_found("Unknown faces endpoint")),
    };

    match result {
        Ok(data) => (200, json!({ "success": true, "message": "OK", "data": data })),
        Err((status, message)) => (status, json!({ "success": false, "message": message })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit vector mostly along `axis`, nudged by `jitter` along `axis + 1`.
    fn embedding(axis: usize, jitter: f32) -> Vec<f32> {
        let mut v = vec![0.0; 512];
        v[axis] = 1.0;
        v[axis + 1] = jitter;
        normalize(v)
    }

    fn detection(axis: usize, jitter: f32) -> FaceDetection {
        FaceDetection {
            bbox: [0.1, 0.1, 0.2, 0.2],
            embedding: embedding(axis, jitter),
        }
    }

    fn photo() -> PhotoRecord {
        PhotoRecord { width: 100, height: 100, date_created: 0 }
    }

    fn person_of(data: &UserFaces, path: &str) -> Vec<String> {
        data.faces.iter().filter(|f| f.path == path).map(|f| f.person_id.clone()).collect()
    }

    #[test]
    fn similar_faces_group_and_different_faces_split() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.1)]);
        data.sync_photo("/b.jpg", photo(), vec![detection(0, 0.2)]);
        data.sync_photo("/c.jpg", photo(), vec![detection(10, 0.0)]);
        assert_eq!(person_of(&data, "/a.jpg"), person_of(&data, "/b.jpg"));
        assert_ne!(person_of(&data, "/a.jpg"), person_of(&data, "/c.jpg"));
        assert_eq!(data.people.len(), 2);
    }

    #[test]
    fn two_faces_in_one_photo_are_different_people() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.1), detection(0, 0.12)]);
        let people = person_of(&data, "/a.jpg");
        assert_eq!(people.len(), 2);
        assert_ne!(people[0], people[1]);
    }

    #[test]
    fn reindexing_keeps_labels_and_reports_no_change() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.1)]);
        let person = person_of(&data, "/a.jpg")[0].clone();
        data.label(&person, Some("Alice"), None).unwrap();
        assert!(!data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.1)]));
        assert_eq!(person_of(&data, "/a.jpg"), vec![person.clone()]);
        assert_eq!(data.people[&person].name.as_deref(), Some("Alice"));

        assert!(data.sync_photo("/a.jpg", photo(), vec![]));
        assert!(data.faces.is_empty());
        assert!(data.people.is_empty());
    }

    #[test]
    fn labelling_with_same_contact_merges_people() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.0)]);
        data.sync_photo("/b.jpg", photo(), vec![detection(10, 0.0)]);
        let a = person_of(&data, "/a.jpg")[0].clone();
        let b = person_of(&data, "/b.jpg")[0].clone();
        data.label(&a, Some("Bob"), Some("contact-1")).unwrap();
        let result = data.label(&b, Some("Bob"), Some("contact-1")).unwrap();
        assert_eq!(result, b);
        assert_eq!(data.people.len(), 1);
        assert_eq!(person_of(&data, "/a.jpg"), vec![b]);
    }

    #[test]
    fn suggestions_skip_rejected_named_and_co_occurring_pairs() {
        let mut data = UserFaces::default();
        // Similar enough to suggest (cosine ~0.6) but below the auto-join threshold.
        let mut near = vec![0.0; 512];
        near[0] = 0.6;
        near[5] = 0.8;
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.0)]);
        data.sync_photo(
            "/b.jpg",
            photo(),
            vec![FaceDetection { bbox: [0.0; 4], embedding: normalize(near) }],
        );
        let a = person_of(&data, "/a.jpg")[0].clone();
        let b = person_of(&data, "/b.jpg")[0].clone();
        assert_ne!(a, b);

        let suggestions = data.suggestions(10);
        assert_eq!(suggestions.len(), 1);
        assert!((suggestions[0].2 - 0.6).abs() < 0.02);

        data.label(&a, Some("Alice"), None).unwrap();
        assert_eq!(data.suggestions(10)[0].1, a, "named person is asked about second");

        data.reject(&a, &b).unwrap();
        assert!(data.suggestions(10).is_empty());
    }

    #[test]
    fn merging_and_assigning_move_faces() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(0, 0.0)]);
        data.sync_photo("/b.jpg", photo(), vec![detection(10, 0.0)]);
        let a = person_of(&data, "/a.jpg")[0].clone();
        let b = person_of(&data, "/b.jpg")[0].clone();
        data.label(&b, Some("Carol"), None).unwrap();

        data.merge(&a, &[b.clone()]).unwrap();
        assert_eq!(data.people.len(), 1);
        assert_eq!(data.people[&a].name.as_deref(), Some("Carol"));

        let face = data.faces.iter().find(|f| f.path == "/b.jpg").unwrap().id.clone();
        let moved_to = data.assign(&face, None).unwrap();
        assert_ne!(moved_to, a);
        let face = data.faces.iter().find(|f| f.id == face).unwrap();
        assert!(face.locked);
        assert_eq!(face.rejected, vec![a.clone()]);
        // A face the user pulled out of a person isn't suggested straight back.
        assert!(data.suggestions(10).iter().all(|(x, y, _)| !(x == &moved_to && y == &a)));
    }

    #[test]
    fn embeddings_round_trip_through_storage() {
        let mut data = UserFaces::default();
        data.sync_photo("/a.jpg", photo(), vec![detection(3, 0.4)]);
        let text = serde_json::to_string(&data).unwrap();
        let restored: UserFaces = serde_json::from_str(&text).unwrap();
        let similarity = cosine(&data.faces[0].embedding, &restored.faces[0].embedding);
        assert!(similarity > 0.999, "similarity was {}", similarity);
    }

    #[test]
    fn parses_contact_names_from_vcard_and_json() {
        let vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Smith;Jane;;;\r\nFN:Jane\r\n  Smith\r\nUID:c-1\r\nEND:VCARD\r\n";
        assert_eq!(
            parse_vcard_summary(vcard),
            (Some("c-1".to_string()), Some("Jane Smith".to_string()))
        );
        let no_fn = "BEGIN:VCARD\nN:Doe;John;Q;;\nUID:c-2\nEND:VCARD\n";
        assert_eq!(parse_vcard_summary(no_fn).1.as_deref(), Some("John Q Doe"));
        let json = r#"{"id":"c-3","firstName":"Ann","surname":"Lee"}"#;
        assert_eq!(
            parse_json_summary(json),
            (Some("c-3".to_string()), Some("Ann Lee".to_string()))
        );
    }

    #[test]
    fn store_persists_and_dispatches_requests() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let photo_path = data_dir.join("alice/Photos/a.jpg");
        fs::create_dir_all(photo_path.parent().unwrap()).unwrap();
        fs::write(&photo_path, b"x").unwrap();
        fs::create_dir_all(data_dir.join("alice/Contacts")).unwrap();
        fs::write(
            data_dir.join("alice/Contacts/c.vcf"),
            "BEGIN:VCARD\nFN:Dana\nUID:dana\nEND:VCARD\n",
        )
        .unwrap();
        let data_dir = data_dir.to_str().unwrap();
        let path = photo_path.to_str().unwrap();

        let store = FaceStore::new(dir.path().join("faces"));
        store.sync_photo("alice", path, (640, 480), 5, vec![detection(0, 0.0)]).unwrap();

        let reopened = FaceStore::new(dir.path().join("faces"));
        let empty = HashMap::new();
        let (status, people) = handle_request(&reopened, data_dir, "alice", "GET", "/api/faces/people", &empty, &Value::Null);
        assert_eq!(status, 200);
        let person_id = people["data"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(people["data"][0]["cover"]["image_width"], 640);

        let (status, _) = handle_request(
            &reopened,
            data_dir,
            "alice",
            "POST",
            "/api/faces/label",
            &empty,
            &json!({ "person_id": person_id, "name": "D", "contact_id": "dana" }),
        );
        assert_eq!(status, 200);
        let (_, faces) = handle_request(
            &reopened,
            data_dir,
            "alice",
            "GET",
            "/api/faces/photo",
            &HashMap::from([("path".to_string(), path.to_string())]),
            &Value::Null,
        );
        assert_eq!(faces["data"][0]["person_name"], "Dana");

        // Another user sees nothing.
        let (_, other) = handle_request(&reopened, data_dir, "bob", "GET", "/api/faces/people", &empty, &Value::Null);
        assert_eq!(other["data"], json!([]));

        fs::remove_file(&photo_path).unwrap();
        let (_, people) = handle_request(&reopened, data_dir, "alice", "GET", "/api/faces/people", &empty, &Value::Null);
        assert_eq!(people["data"], json!([]));
    }
}
