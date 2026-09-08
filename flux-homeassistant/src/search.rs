use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::{Index, IndexReader, IndexWriter, Term};
use tracing::info;

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

#[derive(Clone)]
pub struct SearchManager {
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
}

impl SearchManager {
    pub fn new(index_dir: &str) -> Result<Self, String> {
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
        let schema = schema_builder.build();

        // Open or Create Index
        let index = if index_path.join("meta.json").exists() {
            info!("Loading existing Tantivy index from {:?}", index_path);
            Index::open_in_dir(index_path)
                .map_err(|e| format!("Failed to open existing index: {}", e))?
        } else {
            info!("Creating new Tantivy index in {:?}", index_path);
            Index::create_in_dir(index_path, schema)
                .map_err(|e| format!("Failed to create new index: {}", e))?
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
        })
    }

    pub fn index_document(&self, doc: SearchDocument) -> Result<(), String> {
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
        t_doc.add_text(self.allowed_users_field, doc.allowed_users.join(" "));

        writer
            .add_document(t_doc)
            .map_err(|e| format!("Failed to add document: {}", e))?;

        writer
            .commit()
            .map_err(|e| format!("Failed to commit indexing transaction: {}", e))?;

        let _ = self.reader.reload();

        Ok(())
    }

    pub fn delete_document(&self, path: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.path_field, path);
        writer.delete_term(term);
        writer
            .commit()
            .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;
        let _ = self.reader.reload();
        Ok(())
    }

    pub fn search(&self, query_str: &str, requesting_user: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
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
        let user_query: Box<dyn tantivy::query::Query> = if query_str.trim().is_empty() || query_str == "*" {
            Box::new(tantivy::query::AllQuery)
        } else {
            query_parser
                .parse_query(query_str)
                .map_err(|e| format!("Failed to parse query '{}': {}", query_str, e))?
        };

        // Search broadly by the user query, then filter documents by ownership
        // and sharing permissions at read time. This is more robust than trying
        // to express a joined allowed-users list as a single term query.
        let search_limit = limit.saturating_mul(10).max(limit);
        let top_docs = searcher
            .search(&user_query, &TopDocs::with_limit(search_limit))
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
            let faces = faces_str.split_whitespace().map(|s| s.to_string()).collect();

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

            let allowed_users_str = retrieved_doc
                .get_first(self.allowed_users_field)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let allowed_users = allowed_users_str.split_whitespace().map(|s| s.to_string()).collect::<Vec<_>>();

            let is_visible = owner == requesting_user
                || allowed_users.iter().any(|u| u == requesting_user || u == "*");
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

        registry.add_share("alice", &file_path.to_string_lossy(), vec!["bob".to_string()]).unwrap();
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
        manager.index_document(SearchDocument {
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
        }).unwrap();

        // 2. Index Bob's private cat photo
        manager.index_document(SearchDocument {
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
        }).unwrap();

        // 3. Index Alice's photo shared with Bob
        manager.index_document(SearchDocument {
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
        }).unwrap();

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

        let file_path = data_dir.join("users").join("alice").join("Photos").join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"public photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry.add_share("alice", &file_path.to_string_lossy(), vec!["*".to_string()]).unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let results = manager.search("*", "bob", 10).unwrap();
        assert!(results.iter().any(|r| r.path == file_path.to_string_lossy()));
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

        let file_path = data_dir.join("users").join("alice").join("Photos").join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"shared photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry.add_share("alice", &file_path.to_string_lossy(), vec!["bob".to_string()]).unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results = manager.search("*", "bob", 10).unwrap();
        assert!(bob_results.iter().any(|r| r.path == file_path.to_string_lossy()));

        registry.remove_share("alice", &file_path.to_string_lossy(), "bob").unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results_after_revoke = manager.search("*", "bob", 10).unwrap();
        assert!(!bob_results_after_revoke.iter().any(|r| r.path == file_path.to_string_lossy()));
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

        let file_path = data_dir.join("users").join("alice").join("Photos").join("shared.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"shared photo").unwrap();

        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();
        registry.add_share("alice", &file_path.to_string_lossy(), vec!["bob".to_string()]).unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        registry.add_share("alice", &file_path.to_string_lossy(), vec!["charlie".to_string()]).unwrap();
        FileManager::process_and_index_file(&file_path, &manager, Some(&registry)).unwrap();

        let bob_results = manager.search("*", "bob", 10).unwrap();
        assert!(!bob_results.iter().any(|r| r.path == file_path.to_string_lossy()));

        let charlie_results = manager.search("*", "charlie", 10).unwrap();
        assert!(charlie_results.iter().any(|r| r.path == file_path.to_string_lossy()));
    }
}
