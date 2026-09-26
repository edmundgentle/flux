use crate::faces::FaceStore;
use crate::sharing::ShareRegistry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tantivy::collector::TopDocs;
use tantivy::query::{AllQuery, QueryParser, TermQuery};
use tantivy::schema::*;
use tantivy::{Index, IndexReader, IndexWriter, Term};
use tracing::{info, warn};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchDocument {
    pub path: String,
    pub file_name: String,
    pub content: String,
    pub tags: Vec<String>,
    pub faces: Vec<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub date_created: i64,
    pub owner: String,
    pub allowed_users: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub path: String,
    pub file_name: String,
    pub content_preview: String,
    pub tags: Vec<String>,
    pub faces: Vec<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub date_created: i64,
    pub owner: String,
    pub allowed_users: Vec<String>,
    pub score: f32,
}

/// File modification time in Unix milliseconds.
pub fn file_modified_at(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[derive(Clone)]
pub struct SearchManager {
    root: PathBuf,
    indexes: Arc<RwLock<HashMap<String, Arc<UserIndex>>>>,
    registry: Option<ShareRegistry>,
    faces: FaceStore,
}

struct UserIndex {
    index: Index,
    reader: IndexReader,
    writer: Arc<Mutex<IndexWriter>>,
    path_field: Field,
    file_name_field: Field,
    content_field: Field,
    tags_field: Field,
    faces_field: Field,
    latitude_field: Field,
    longitude_field: Field,
    date_created_field: Field,
    owner_field: Field,
    allowed_users_field: Field,
    modified_at_field: Field,
}

impl UserIndex {
    fn new(index_dir: &Path) -> Result<Self, String> {
        let index_path = Path::new(index_dir);
        if !index_path.exists() {
            fs::create_dir_all(index_path)
                .map_err(|e| format!("Failed to create index directory: {}", e))?;
        }

        // Define Schema
        let mut schema_builder = Schema::builder();
        let path_field = schema_builder.add_text_field("path", STRING | STORED);
        let file_name_field = schema_builder.add_text_field("file_name", TEXT | STORED);
        let content_field = schema_builder.add_text_field("content", TEXT | STORED);
        let tags_field = schema_builder.add_text_field("tags", TEXT | STORED);
        let faces_field = schema_builder.add_text_field("faces", TEXT | STORED);
        let latitude_field = schema_builder.add_f64_field("latitude", STORED);
        let longitude_field = schema_builder.add_f64_field("longitude", STORED);
        let date_created_field = schema_builder.add_i64_field("date_created", INDEXED | STORED);
        let owner_field = schema_builder.add_text_field("owner", STRING | STORED);
        let allowed_users_field = schema_builder.add_text_field("allowed_users", STRING | STORED);
        let modified_at_field = schema_builder.add_i64_field("modified_at", STORED);
        let schema = schema_builder.build();

        // Open or Create Index
        let existing = if index_path.join("meta.json").exists() {
            info!("Loading existing Tantivy index from {:?}", index_path);
            let index = Index::open_in_dir(index_path)
                .map_err(|e| format!("Failed to open existing index: {}", e))?;
            if index.schema().get_field("modified_at").is_ok() {
                Some(index)
            } else {
                warn!("Index at {:?} predates the current schema; rebuilding it", index_path);
                drop(index);
                Self::clear_index_files(index_path)?;
                None
            }
        } else {
            None
        };
        let index = match existing {
            Some(index) => index,
            None => {
                info!("Creating new Tantivy index in {:?}", index_path);
                Index::create_in_dir(index_path, schema)
                    .map_err(|e| format!("Failed to create new index: {}", e))?
            }
        };

        let writer = index
            .writer(50_000_000)
            .map_err(|e| format!("Failed to create index writer: {}", e))?;

        let reader = index
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| format!("Failed to create index reader: {}", e))?;

        Ok(Self {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            path_field,
            file_name_field,
            content_field,
            tags_field,
            faces_field,
            latitude_field,
            longitude_field,
            date_created_field,
            owner_field,
            allowed_users_field,
            modified_at_field,
        })
    }

    /// Removes the index's own files, leaving subdirectories (other users' indexes) alone.
    fn clear_index_files(index_path: &Path) -> Result<(), String> {
        let entries = fs::read_dir(index_path)
            .map_err(|e| format!("Failed to read index directory: {}", e))?;
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                fs::remove_file(entry.path())
                    .map_err(|e| format!("Failed to remove stale index file: {}", e))?;
            }
        }
        Ok(())
    }

    fn modified_at(&self, path: &str) -> Result<Option<i64>, String> {
        let searcher = self.reader.searcher();
        let query = TermQuery::new(
            Term::from_field_text(self.path_field, path),
            IndexRecordOption::Basic,
        );
        let hits = searcher
            .search(&query, &TopDocs::with_limit(1))
            .map_err(|e| e.to_string())?;
        let Some((_, address)) = hits.first() else {
            return Ok(None);
        };
        let doc = searcher
            .doc::<tantivy::TantivyDocument>(*address)
            .map_err(|e| format!("Failed to read indexed document: {}", e))?;
        Ok(doc
            .get_first(self.modified_at_field)
            .and_then(|value| value.as_i64()))
    }

    fn index_document(&self, doc: SearchDocument) -> Result<(), String> {
        let modified_at = file_modified_at(Path::new(&doc.path));
        let mut writer = self.writer.lock().unwrap();

        // Delete existing document with the same path (upsert)
        let term = Term::from_field_text(self.path_field, &doc.path);
        writer.delete_term(term);

        // Build new document
        let mut t_doc = tantivy::TantivyDocument::new();
        t_doc.add_text(self.path_field, doc.path);
        t_doc.add_text(self.file_name_field, doc.file_name);
        t_doc.add_text(self.content_field, doc.content);
        t_doc.add_text(self.tags_field, doc.tags.join(" "));
        t_doc.add_text(self.faces_field, doc.faces.join(" "));

        if let Some(lat) = doc.latitude {
            t_doc.add_f64(self.latitude_field, lat);
        }
        if let Some(lon) = doc.longitude {
            t_doc.add_f64(self.longitude_field, lon);
        }
        t_doc.add_i64(self.date_created_field, doc.date_created);
        t_doc.add_text(self.owner_field, doc.owner);
        for user in doc.allowed_users {
            t_doc.add_text(self.allowed_users_field, user);
        }
        if let Some(modified_at) = modified_at {
            t_doc.add_i64(self.modified_at_field, modified_at);
        }

        writer
            .add_document(t_doc)
            .map_err(|e| format!("Failed to add document: {}", e))?;

        writer
            .commit()
            .map_err(|e| format!("Failed to commit indexing transaction: {}", e))?;

        let _ = self.reader.reload();

        Ok(())
    }

    fn delete_document(&self, path: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.path_field, path);
        writer.delete_term(term);
        writer
            .commit()
            .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;
        let _ = self.reader.reload();
        Ok(())
    }

    fn document_at(&self, address: tantivy::DocAddress) -> Result<SearchDocument, String> {
        let doc = self
            .reader
            .searcher()
            .doc::<tantivy::TantivyDocument>(address)
            .map_err(|e| format!("Failed to read indexed document: {}", e))?;
        let text = |field| {
            doc.get_first(field)
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        };
        Ok(SearchDocument {
            path: text(self.path_field),
            file_name: text(self.file_name_field),
            content: text(self.content_field),
            tags: text(self.tags_field)
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            faces: text(self.faces_field)
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            latitude: doc
                .get_first(self.latitude_field)
                .and_then(|value| value.as_f64()),
            longitude: doc
                .get_first(self.longitude_field)
                .and_then(|value| value.as_f64()),
            date_created: doc
                .get_first(self.date_created_field)
                .and_then(|value| value.as_i64())
                .unwrap_or(0),
            owner: text(self.owner_field),
            allowed_users: doc
                .get_all(self.allowed_users_field)
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect(),
        })
    }

    fn get_document(&self, path: &str) -> Result<Option<SearchDocument>, String> {
        let searcher = self.reader.searcher();
        let query = TermQuery::new(
            Term::from_field_text(self.path_field, path),
            IndexRecordOption::Basic,
        );
        let hits = searcher
            .search(&query, &TopDocs::with_limit(1))
            .map_err(|e| e.to_string())?;
        hits.first()
            .map(|(_, address)| self.document_at(*address))
            .transpose()
    }

    fn all_documents(&self) -> Result<Vec<SearchDocument>, String> {
        let searcher = self.reader.searcher();
        let count = searcher.num_docs() as usize;
        if count == 0 {
            return Ok(Vec::new());
        }
        let hits = searcher
            .search(&AllQuery, &TopDocs::with_limit(count))
            .map_err(|e| e.to_string())?;
        hits.into_iter()
            .map(|(_, address)| self.document_at(address))
            .collect()
    }

    fn search(
        &self,
        query_str: &str,
        requesting_user: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, String> {
        let _ = self.reader.reload();
        let searcher = self.reader.searcher();

        let query_parser = QueryParser::for_index(
            &self.index,
            vec![
                self.file_name_field,
                self.content_field,
                self.tags_field,
                self.faces_field,
            ],
        );

        // Treat empty query as match-all
        let user_query: Box<dyn tantivy::query::Query> =
            if query_str.trim().is_empty() || query_str == "*" {
                Box::new(AllQuery)
            } else {
                query_parser
                    .parse_query(query_str)
                    .map_err(|e| format!("Failed to parse query '{}': {}", query_str, e))?
            };

        let top_docs = searcher
            .search(&user_query, &TopDocs::with_limit(limit))
            .map_err(|e| format!("Search failed: {}", e))?;

        let mut results = Vec::new();
        for (score, doc_address) in top_docs {
            let retrieved_doc = searcher
                .doc::<tantivy::TantivyDocument>(doc_address)
                .map_err(|e| format!("Failed to retrieve document from address: {}", e))?;

            let path = retrieved_doc
                .get_first(self.path_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let file_name = retrieved_doc
                .get_first(self.file_name_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let content = retrieved_doc
                .get_first(self.content_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let content_preview = if content.len() > 200 {
                format!("{}...", &content[..200])
            } else {
                content
            };

            let tags_str = retrieved_doc
                .get_first(self.tags_field)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tags = tags_str.split_whitespace().map(|s| s.to_string()).collect();

            let faces_str = retrieved_doc
                .get_first(self.faces_field)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let faces = faces_str
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();

            let latitude = retrieved_doc
                .get_first(self.latitude_field)
                .and_then(|v| v.as_f64());

            let longitude = retrieved_doc
                .get_first(self.longitude_field)
                .and_then(|v| v.as_f64());

            let date_created = retrieved_doc
                .get_first(self.date_created_field)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            let owner = retrieved_doc
                .get_first(self.owner_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let allowed_users = retrieved_doc
                .get_all(self.allowed_users_field)
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>();

            let is_visible = owner == requesting_user
                || allowed_users
                    .iter()
                    .any(|u| u == requesting_user || u == "*");
            if !is_visible {
                continue;
            }

            if results.len() >= limit {
                break;
            }

            results.push(SearchResult {
                path,
                file_name,
                content_preview,
                tags,
                faces,
                latitude,
                longitude,
                date_created,
                owner,
                allowed_users,
                score,
            });
        }

        Ok(results)
    }
}

impl SearchManager {
    pub fn new(index_dir: &str) -> Result<Self, String> {
        let root = PathBuf::from(index_dir);
        fs::create_dir_all(&root).map_err(|e| format!("Failed to create index root: {}", e))?;
        Ok(Self {
            faces: FaceStore::new(root.join("faces")),
            root,
            indexes: Arc::new(RwLock::new(HashMap::new())),
            registry: None,
        })
    }

    pub fn faces(&self) -> &FaceStore {
        &self.faces
    }

    /// True when `path` is already in `owner`'s index and hasn't been modified since.
    pub fn is_indexed_and_unchanged(&self, owner: &str, path: &Path) -> bool {
        let Some(current) = file_modified_at(path) else {
            return false;
        };
        let Ok(Some(index)) = self.get_index(&Self::user_key(owner), false) else {
            return false;
        };
        matches!(index.modified_at(&path.to_string_lossy()), Ok(Some(indexed)) if indexed == current)
    }

    pub fn with_registry(index_dir: &str, registry: ShareRegistry) -> Result<Self, String> {
        let mut manager = Self::new(index_dir)?;
        manager.registry = Some(registry);
        manager.migrate_legacy_index()?;
        Ok(manager)
    }

    fn migrate_legacy_index(&self) -> Result<(), String> {
        if !self.root.join("meta.json").exists() || self.root.join("per-user-migrated").exists() {
            return Ok(());
        }
        let legacy = UserIndex::new(&self.root)?;
        for mut doc in legacy.all_documents()? {
            if !Path::new(&doc.path).is_file() {
                continue;
            }
            if let Some(registry) = &self.registry {
                doc.allowed_users = registry.get_allowed_users(&doc.path);
            }
            self.index_document(doc)?;
        }
        fs::write(self.root.join("per-user-migrated"), b"")
            .map_err(|e| format!("Failed to mark index migration complete: {}", e))
    }

    fn user_key(user: &str) -> String {
        format!(
            "u-{:x}",
            Sha256::digest(user.trim().to_lowercase().as_bytes())
        )
    }

    fn get_index(&self, key: &str, create: bool) -> Result<Option<Arc<UserIndex>>, String> {
        if let Some(index) = self.indexes.read().unwrap().get(key) {
            return Ok(Some(index.clone()));
        }
        let path = self.root.join(key);
        if !create && !path.join("meta.json").exists() {
            return Ok(None);
        }
        let mut indexes = self.indexes.write().unwrap();
        if let Some(index) = indexes.get(key) {
            return Ok(Some(index.clone()));
        }
        let index = Arc::new(UserIndex::new(&path)?);
        indexes.insert(key.to_string(), index.clone());
        Ok(Some(index))
    }

    fn existing_keys(&self) -> Result<HashSet<String>, String> {
        let mut keys: HashSet<String> = self.indexes.read().unwrap().keys().cloned().collect();
        for entry in
            fs::read_dir(&self.root).map_err(|e| format!("Failed to list indexes: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read index entry: {}", e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("u-") || name == "_public")
                && entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && entry.path().join("meta.json").exists()
            {
                keys.insert(name);
            }
        }
        Ok(keys)
    }

    pub fn index_document(&self, doc: SearchDocument) -> Result<(), String> {
        let mut recipients = HashSet::from([Self::user_key(&doc.owner)]);
        for user in &doc.allowed_users {
            if user == "*" {
                recipients.insert("_public".to_string());
            } else if !user.trim().is_empty() {
                recipients.insert(Self::user_key(user));
            }
        }
        let owner_key = Self::user_key(&doc.owner);
        if let Some(owner_index) = self.get_index(&owner_key, false)? {
            if let Some(previous) = owner_index.get_document(&doc.path)? {
                for user in previous.allowed_users {
                    let key = if user == "*" {
                        "_public".to_string()
                    } else {
                        Self::user_key(&user)
                    };
                    if !recipients.contains(&key) {
                        if let Some(index) = self.get_index(&key, false)? {
                            index.delete_document(&doc.path)?;
                        }
                    }
                }
            }
        }
        for key in recipients {
            self.get_index(&key, true)?
                .unwrap()
                .index_document(doc.clone())?;
        }
        Ok(())
    }

    pub fn delete_document(&self, path: &str) -> Result<(), String> {
        let mut owner = None;
        for key in self.existing_keys()? {
            if let Some(index) = self.get_index(&key, false)? {
                if owner.is_none() {
                    owner = index.get_document(path)?.map(|doc| doc.owner);
                }
                index.delete_document(path)?;
            }
        }
        if let Some(owner) = owner {
            if let Err(e) = self.faces.remove_photo(&owner, path) {
                warn!("Failed to remove faces for deleted file {:?}: {}", path, e);
            }
        }
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        user: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for key in [Self::user_key(user), "_public".to_string()] {
            if let Some(index) = self.get_index(&key, false)? {
                results.extend(index.search(query, user, limit)?);
            }
        }
        results.retain(|result| {
            self.registry.as_ref().is_none_or(|registry| {
                (result.owner.eq_ignore_ascii_case(user) && Path::new(&result.path).is_file())
                    || registry.check_access(user, &result.path)
            })
        });
        results.sort_by(|left, right| right.score.total_cmp(&left.score));
        let mut seen = HashSet::new();
        results.retain(|result| seen.insert(result.path.clone()));
        results.truncate(limit);
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileManager;
    use crate::sharing::ShareRegistry;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_file_indexing_and_sharing_flow() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let data_dir = dir.path().join("data");
        fs::create_dir_all(&index_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();

        let manager = SearchManager::new(index_dir.to_str().unwrap()).unwrap();
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());

        let file_path = data_dir
            .join("users")
            .join("alice")
            .join("Photos")
            .join("vacation.jpg");
        let parent = file_path.parent().unwrap();
        fs::create_dir_all(parent).unwrap();
        fs::write(&file_path, b"placeholder image data").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let alice_results = manager.search("*", "alice", 10).unwrap();
        assert_eq!(alice_results.len(), 1);

        registry
            .add_share(
                "alice",
                &file_path.to_string_lossy(),
                vec!["bob".to_string()],
            )
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results = manager.search("*", "bob", 10).unwrap();
        assert_eq!(bob_results.len(), 1);

        let charlie_results = manager.search("*", "charlie", 10).unwrap();
        assert!(charlie_results.is_empty());
    }

    #[test]
    fn test_indexing_and_searching_with_users() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().to_str().unwrap();
        let manager = SearchManager::new(index_dir).unwrap();

        // 1. Index Alice's private dog photo
        manager
            .index_document(SearchDocument {
                path: "/share/users/alice/dog.jpg".to_string(),
                file_name: "dog.jpg".to_string(),
                content: "A photo of a black dog".to_string(),
                tags: vec!["dog".to_string()],
                faces: vec![],
                latitude: None,
                longitude: None,
                date_created: 1690000000,
                owner: "alice".to_string(),
                allowed_users: vec!["alice".to_string()],
            })
            .unwrap();

        // 2. Index Bob's private cat photo
        manager
            .index_document(SearchDocument {
                path: "/share/users/bob/cat.jpg".to_string(),
                file_name: "cat.jpg".to_string(),
                content: "A photo of a white cat".to_string(),
                tags: vec!["cat".to_string()],
                faces: vec![],
                latitude: None,
                longitude: None,
                date_created: 1690000000,
                owner: "bob".to_string(),
                allowed_users: vec!["bob".to_string()],
            })
            .unwrap();

        // 3. Index Alice's photo shared with Bob
        manager
            .index_document(SearchDocument {
                path: "/share/users/alice/shared_sunset.jpg".to_string(),
                file_name: "shared_sunset.jpg".to_string(),
                content: "A warm sunset".to_string(),
                tags: vec!["sunset".to_string()],
                faces: vec![],
                latitude: None,
                longitude: None,
                date_created: 1690000000,
                owner: "alice".to_string(),
                allowed_users: vec!["alice".to_string(), "bob".to_string()],
            })
            .unwrap();

        // Bob searches
        let bob_results = manager.search("*", "bob", 10).unwrap();
        // Should find Bob's cat and Alice's sunset, but NOT Alice's dog
        assert_eq!(bob_results.len(), 2);
        let paths: Vec<String> = bob_results.iter().map(|r| r.path.clone()).collect();
        assert!(paths.contains(&"/share/users/bob/cat.jpg".to_string()));
        assert!(paths.contains(&"/share/users/alice/shared_sunset.jpg".to_string()));
        assert!(!paths.contains(&"/share/users/alice/dog.jpg".to_string()));

        // Alice searches
        let alice_results = manager.search("*", "alice", 10).unwrap();
        // Should find Alice's dog and Alice's sunset, but NOT Bob's cat
        assert_eq!(alice_results.len(), 2);
        let paths_alice: Vec<String> = alice_results.iter().map(|r| r.path.clone()).collect();
        assert!(paths_alice.contains(&"/share/users/alice/dog.jpg".to_string()));
        assert!(paths_alice.contains(&"/share/users/alice/shared_sunset.jpg".to_string()));
        assert!(!paths_alice.contains(&"/share/users/users/bob/cat.jpg".to_string()));
    }

    #[test]
    fn test_public_wildcard_share_is_visible_to_other_users() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let data_dir = dir.path().join("data");
        fs::create_dir_all(&index_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();

        let manager = SearchManager::new(index_dir.to_str().unwrap()).unwrap();
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());

        let file_path = data_dir
            .join("users")
            .join("alice")
            .join("Photos")
            .join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"public photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry
            .add_share("alice", &file_path.to_string_lossy(), vec!["*".to_string()])
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let results = manager.search("*", "bob", 10).unwrap();
        assert!(results
            .iter()
            .any(|r| r.path == file_path.to_string_lossy()));
    }

    #[test]
    fn test_revoking_share_removes_access_from_search_results() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let data_dir = dir.path().join("data");
        fs::create_dir_all(&index_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();

        let manager = SearchManager::new(index_dir.to_str().unwrap()).unwrap();
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());

        let file_path = data_dir
            .join("users")
            .join("alice")
            .join("Photos")
            .join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"shared photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry
            .add_share(
                "alice",
                &file_path.to_string_lossy(),
                vec!["bob".to_string()],
            )
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results = manager.search("*", "bob", 10).unwrap();
        assert!(bob_results
            .iter()
            .any(|r| r.path == file_path.to_string_lossy()));

        registry
            .remove_share("alice", &file_path.to_string_lossy(), "bob")
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results_after_revoke = manager.search("*", "bob", 10).unwrap();
        assert!(!bob_results_after_revoke
            .iter()
            .any(|r| r.path == file_path.to_string_lossy()));
    }

    #[test]
    fn test_permission_update_replaces_previous_shared_users() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let data_dir = dir.path().join("data");
        fs::create_dir_all(&index_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();

        let manager = SearchManager::new(index_dir.to_str().unwrap()).unwrap();
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());

        let file_path = data_dir
            .join("users")
            .join("alice")
            .join("Photos")
            .join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"shared photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry
            .add_share(
                "alice",
                &file_path.to_string_lossy(),
                vec!["bob".to_string()],
            )
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        registry
            .add_share(
                "alice",
                &file_path.to_string_lossy(),
                vec!["charlie".to_string()],
            )
            .unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results = manager.search("*", "bob", 10).unwrap();
        assert!(!bob_results
            .iter()
            .any(|r| r.path == file_path.to_string_lossy()));

        assert!(manager
            .get_index(&SearchManager::user_key("bob"), false)
            .unwrap()
            .unwrap()
            .get_document(file_path.to_str().unwrap())
            .unwrap()
            .is_none());

        let charlie_results = manager.search("*", "charlie", 10).unwrap();
        assert!(charlie_results
            .iter()
            .any(|r| r.path == file_path.to_string_lossy()));
    }

    #[test]
    fn user_search_is_not_crowded_out_by_other_users() {
        let dir = tempdir().unwrap();
        let manager = SearchManager::new(dir.path().to_str().unwrap()).unwrap();
        for number in 0..30 {
            manager
                .index_document(SearchDocument {
                    path: format!("/users/bob/{}.txt", number),
                    file_name: "match.txt".to_string(),
                    content: "match match match".to_string(),
                    tags: vec![],
                    faces: vec![],
                    latitude: None,
                    longitude: None,
                    date_created: 0,
                    owner: "bob".to_string(),
                    allowed_users: vec![],
                })
                .unwrap();
        }
        manager
            .index_document(SearchDocument {
                path: "/users/alice/only.txt".to_string(),
                file_name: "only.txt".to_string(),
                content: "match".to_string(),
                tags: vec![],
                faces: vec![],
                latitude: None,
                longitude: None,
                date_created: 0,
                owner: "alice".to_string(),
                allowed_users: vec![],
            })
            .unwrap();
        assert_eq!(
            manager.search("match", "alice", 1).unwrap()[0].path,
            "/users/alice/only.txt"
        );
        assert!(!dir.path().join("meta.json").exists());
        assert!(dir
            .path()
            .join(SearchManager::user_key("alice"))
            .join("meta.json")
            .exists());
        assert!(dir
            .path()
            .join(SearchManager::user_key("bob"))
            .join("meta.json")
            .exists());
    }

    #[test]
    fn shared_username_with_spaces_remains_exact() {
        let dir = tempdir().unwrap();
        let manager = SearchManager::new(dir.path().to_str().unwrap()).unwrap();
        let mut doc = SearchDocument {
            path: "/users/alice/shared.txt".to_string(),
            file_name: "shared.txt".to_string(),
            content: "hello".to_string(),
            tags: vec![],
            faces: vec![],
            latitude: None,
            longitude: None,
            date_created: 0,
            owner: "alice".to_string(),
            allowed_users: vec!["mary jane".to_string()],
        };
        manager.index_document(doc.clone()).unwrap();
        assert_eq!(manager.search("hello", "mary jane", 10).unwrap().len(), 1);
        assert!(manager.search("hello", "mary", 10).unwrap().is_empty());
        doc.allowed_users.clear();
        manager.index_document(doc).unwrap();
        assert!(manager.search("hello", "mary jane", 10).unwrap().is_empty());
        assert!(manager
            .get_index(&SearchManager::user_key("mary jane"), false)
            .unwrap()
            .unwrap()
            .get_document("/users/alice/shared.txt")
            .unwrap()
            .is_none());
    }

    #[test]
    fn public_search_and_revocation_survive_reopening_indexes() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let index_dir = dir.path().join("index");
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());
        let file = data_dir.join("users/alice/shared.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "hello").unwrap();
        let manager =
            SearchManager::with_registry(index_dir.to_str().unwrap(), registry.clone()).unwrap();
        registry
            .add_share("alice", file.to_str().unwrap(), vec!["*".to_string()])
            .unwrap();
        FileManager::process_and_index_file(&file, &manager, Some(&registry)).unwrap();
        assert_eq!(manager.search("hello", "new_user", 10).unwrap().len(), 1);
        drop(manager);

        let manager =
            SearchManager::with_registry(index_dir.to_str().unwrap(), registry.clone()).unwrap();
        assert_eq!(manager.search("hello", "new_user", 10).unwrap().len(), 1);
        registry
            .remove_share("alice", file.to_str().unwrap(), "*")
            .unwrap();
        assert!(manager.search("hello", "new_user", 10).unwrap().is_empty());
        FileManager::process_and_index_file(&file, &manager, Some(&registry)).unwrap();
        assert!(manager
            .get_index("_public", false)
            .unwrap()
            .unwrap()
            .get_document(file.to_str().unwrap())
            .unwrap()
            .is_none());
        assert_eq!(manager.search("hello", "alice", 10).unwrap().len(), 1);
        manager.delete_document(file.to_str().unwrap()).unwrap();
        assert!(manager.search("hello", "alice", 10).unwrap().is_empty());
    }

    #[test]
    fn deleting_shared_file_clears_index_and_share_record() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let index_dir = dir.path().join("index");
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());
        let file = data_dir.join("users/alice/shared.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "hello").unwrap();
        registry
            .add_share("alice", file.to_str().unwrap(), vec!["bob".to_string()])
            .unwrap();
        let manager =
            SearchManager::with_registry(index_dir.to_str().unwrap(), registry.clone()).unwrap();
        FileManager::process_and_index_file(&file, &manager, Some(&registry)).unwrap();
        assert_eq!(manager.search("hello", "bob", 10).unwrap().len(), 1);

        FileManager::delete_file(&file, &manager).unwrap();
        registry
            .remove_deleted_file(file.to_str().unwrap())
            .unwrap();
        fs::write(&file, "replacement").unwrap();
        FileManager::process_and_index_file(&file, &manager, Some(&registry)).unwrap();
        assert!(manager.search("replacement", "bob", 10).unwrap().is_empty());
        assert_eq!(manager.search("replacement", "alice", 10).unwrap().len(), 1);
    }

    #[test]
    fn migrates_legacy_index_with_current_permissions() {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let data_dir = dir.path().join("data");
        let registry = ShareRegistry::new(data_dir.to_str().unwrap());
        let file = data_dir.join("users/alice/old.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "old contents").unwrap();
        let legacy = UserIndex::new(&index_dir).unwrap();
        legacy
            .index_document(SearchDocument {
                path: file.to_string_lossy().to_string(),
                file_name: "old.txt".to_string(),
                content: "old contents".to_string(),
                tags: vec![],
                faces: vec![],
                latitude: None,
                longitude: None,
                date_created: 0,
                owner: "alice".to_string(),
                allowed_users: vec!["bob".to_string()],
            })
            .unwrap();
        drop(legacy);
        let manager = SearchManager::with_registry(index_dir.to_str().unwrap(), registry).unwrap();
        assert_eq!(manager.search("old", "alice", 10).unwrap().len(), 1);
        assert!(manager.search("old", "bob", 10).unwrap().is_empty());
        assert!(index_dir.join("per-user-migrated").exists());
    }
}
