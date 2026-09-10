//! Local, offline object/face detection and facial fingerprinting powered by ONNX Runtime (`ort`).
//!
//! Models used (see `models/download-models.sh` for how to obtain them):
//! - `yolov8n.onnx` — Ultralytics YOLOv8 general object detector (COCO 80-class label map)
//! - `yolov8n-face.onnx` — Ultralytics YOLOv8 model fine-tuned for face detection (single class)
//! - `facenet512.onnx` — DeepFace "Facenet512" face-embedding model, used to fingerprint/cluster
//!   faces by identity instead of by raw pixel similarity
//!
//! Each model is loaded independently and lazily from the directory pointed to by the
//! `MODELS_DIR` env var (default `/app/models`). If a given model is missing or fails to load,
//! only the feature it powers is skipped — the rest of the pipeline still runs.

use image::{imageops::FilterType, DynamicImage, GenericImageView};
use ndarray::{Array3, Array4, Axis};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tracing::warn;

pub struct VisionResult {
    pub object_tags: Vec<String>,
    pub face_count: usize,
    /// One fingerprint tag (e.g. `face_cluster_xxxxxxxxxxxxxxxx`) per detected face, derived
    /// from a locality-sensitive hash of its Facenet512 embedding so photos of the same person
    /// tend to land in the same bucket.
    pub face_fingerprints: Vec<String>,
}

struct VisionModels {
    object_session: Option<Mutex<Session>>,
    face_session: Option<Mutex<Session>>,
    embedding_session: Option<Mutex<Session>>,
}

static VISION_MODELS: OnceLock<VisionModels> = OnceLock::new();

fn models_dir() -> PathBuf {
    std::env::var("MODELS_DIR").unwrap_or_else(|_| "/app/models".to_string()).into()
}

fn load_session(dir: &Path, file_name: &str) -> Option<Session> {
    let path = dir.join(file_name);
    let result = (|| -> Result<Session, String> {
        Session::builder()
            .map_err(|e| e.to_string())?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .commit_from_file(&path)
            .map_err(|e| e.to_string())
    })();
    match result {
        Ok(session) => Some(session),
        Err(e) => {
            warn!("Vision model {:?} unavailable, related detection will be skipped: {}", path, e);
            None
        }
    }
}

fn get_models() -> &'static VisionModels {
    VISION_MODELS.get_or_init(|| {
        let dir = models_dir();
        VisionModels {
            object_session: load_session(&dir, "yolov8n.onnx").map(Mutex::new),
            face_session: load_session(&dir, "yolov8n-face.onnx").map(Mutex::new),
            embedding_session: load_session(&dir, "facenet512.onnx").map(Mutex::new),
        }
    })
}

/// Runs object detection + face detection/fingerprinting on an already-decoded image.
/// Returns an empty/default result (never an error) for any model that isn't available.
pub fn analyze(img: &DynamicImage) -> VisionResult {
    let models = get_models();

    let object_tags = detect_objects(models, img).unwrap_or_else(|e| {
        warn!("Object detection failed: {}", e);
        Vec::new()
    });

    let (face_count, face_fingerprints) = detect_faces(models, img).unwrap_or_else(|e| {
        warn!("Face detection/fingerprinting failed: {}", e);
        (0, Vec::new())
    });

    VisionResult { object_tags, face_count, face_fingerprints }
}

/// Greedy non-max suppression over (score, class_id, [x1,y1,x2,y2]) candidates, applied
/// independently within each class.
fn nms_per_class(mut candidates: Vec<(f32, u32, [f32; 4])>, iou_threshold: f32) -> Vec<(f32, u32, [f32; 4])> {
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<(f32, u32, [f32; 4])> = Vec::new();
    for candidate in candidates {
        let overlaps_kept = kept
            .iter()
            .any(|k| k.1 == candidate.1 && iou(&k.2, &candidate.2) >= iou_threshold);
        if !overlaps_kept {
            kept.push(candidate);
        }
    }
    kept
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = a[2].min(b[2]);
    let y2 = a[3].min(b[3]);

    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    let area_a = (a[2] - a[0]).max(0.0) * (a[3] - a[1]).max(0.0);
    let area_b = (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0);
    let union = area_a + area_b - intersection;

    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

/// Resizes `img` to `size`x`size` and returns it as a `1x3xHxW` float tensor scaled to 0..1,
/// which is the input layout Ultralytics YOLOv8 ONNX exports expect.
fn to_yolo_input(img: &DynamicImage, size: u32) -> Array4<f32> {
    let resized = img.resize_exact(size, size, FilterType::Triangle).to_rgb8();
    let mut chw = Array3::<f32>::zeros((3, size as usize, size as usize));
    for y in 0..size {
        for x in 0..size {
            let pixel = resized.get_pixel(x, y);
            for c in 0..3 {
                chw[[c, y as usize, x as usize]] = pixel[c] as f32 / 255.0;
            }
        }
    }
    chw.insert_axis(Axis(0))
}

fn detect_objects(models: &VisionModels, img: &DynamicImage) -> Result<Vec<String>, String> {
    const INPUT_SIZE: u32 = 640;
    const CONFIDENCE_THRESHOLD: f32 = 0.4;
    const IOU_THRESHOLD: f32 = 0.45;

    let Some(object_session) = &models.object_session else {
        return Ok(Vec::new());
    };

    let input = Tensor::from_array(to_yolo_input(img, INPUT_SIZE)).map_err(|e| e.to_string())?;
    let mut session = object_session.lock().map_err(|_| "object session lock poisoned".to_string())?;
    let outputs = session.run(ort::inputs!["images" => input]).map_err(|e| e.to_string())?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let shape = shape.to_vec();
    let data = data.to_vec();
    drop(outputs);
    drop(session);

    // YOLOv8 detection output: [1, 4 + num_classes, num_anchors] (box coords + per-class scores).
    let num_channels = *shape.get(1).ok_or("unexpected object output shape")? as usize;
    let num_anchors = *shape.get(2).ok_or("unexpected object output shape")? as usize;
    let num_classes = num_channels.saturating_sub(4);

    let mut candidates: Vec<(f32, u32, [f32; 4])> = Vec::new();
    for a in 0..num_anchors {
        let cx = data[a];
        let cy = data[num_anchors + a];
        let w = data[2 * num_anchors + a];
        let h = data[3 * num_anchors + a];

        let mut best_score = 0.0f32;
        let mut best_class = 0u32;
        for c in 0..num_classes {
            let score = data[(4 + c) * num_anchors + a];
            if score > best_score {
                best_score = score;
                best_class = c as u32;
            }
        }
        if best_score < CONFIDENCE_THRESHOLD {
            continue;
        }
        let x1 = cx - w / 2.0;
        let y1 = cy - h / 2.0;
        let x2 = cx + w / 2.0;
        let y2 = cy + h / 2.0;
        candidates.push((best_score, best_class, [x1, y1, x2, y2]));
    }

    let kept = nms_per_class(candidates, IOU_THRESHOLD);

    let mut tags = Vec::new();
    for (_, class_id, _) in kept {
        if let Some(label) = coco80_label(class_id) {
            if !tags.contains(&label.to_string()) {
                tags.push(label.to_string());
            }
        }
    }
    Ok(tags)
}

/// Detects faces and fingerprints each one via its Facenet512 embedding.
/// Returns (face_count, face_fingerprints).
fn detect_faces(models: &VisionModels, img: &DynamicImage) -> Result<(usize, Vec<String>), String> {
    const INPUT_SIZE: u32 = 640;
    const CONFIDENCE_THRESHOLD: f32 = 0.5;
    const IOU_THRESHOLD: f32 = 0.45;
    const MAX_FACES_TO_PROCESS: usize = 8;

    let Some(face_session) = &models.face_session else {
        return Ok((0, Vec::new()));
    };

    let (orig_width, orig_height) = img.dimensions();
    let input = Tensor::from_array(to_yolo_input(img, INPUT_SIZE)).map_err(|e| e.to_string())?;

    let mut session = face_session.lock().map_err(|_| "face session lock poisoned".to_string())?;
    let outputs = session.run(ort::inputs!["images" => input]).map_err(|e| e.to_string())?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let shape = shape.to_vec();
    let data = data.to_vec();
    drop(outputs);
    drop(session);

    // Single-class YOLOv8 face detector output: [1, 5, num_anchors] (box coords + face score).
    let num_anchors = *shape.get(2).ok_or("unexpected face output shape")? as usize;

    let mut candidates: Vec<(f32, u32, [f32; 4])> = Vec::new();
    for a in 0..num_anchors {
        let score = data[4 * num_anchors + a];
        if score < CONFIDENCE_THRESHOLD {
            continue;
        }
        let cx = data[a];
        let cy = data[num_anchors + a];
        let w = data[2 * num_anchors + a];
        let h = data[3 * num_anchors + a];
        let x1 = cx - w / 2.0;
        let y1 = cy - h / 2.0;
        let x2 = cx + w / 2.0;
        let y2 = cy + h / 2.0;
        candidates.push((score, 0, [x1, y1, x2, y2]));
    }

    let kept = nms_per_class(candidates, IOU_THRESHOLD);
    let face_count = kept.len();

    let scale_x = orig_width as f32 / INPUT_SIZE as f32;
    let scale_y = orig_height as f32 / INPUT_SIZE as f32;

    let mut face_fingerprints = Vec::new();
    for (_, _, b) in kept.iter().take(MAX_FACES_TO_PROCESS) {
        let x1 = (b[0] * scale_x).max(0.0) as u32;
        let y1 = (b[1] * scale_y).max(0.0) as u32;
        let x2 = (b[2] * scale_x).min(orig_width as f32) as u32;
        let y2 = (b[3] * scale_y).min(orig_height as f32) as u32;
        if x2 <= x1 || y2 <= y1 {
            continue;
        }

        let crop = img.crop_imm(x1, y1, x2 - x1, y2 - y1);

        if let Ok(embedding) = compute_face_embedding(models, &crop) {
            face_fingerprints.push(face_fingerprint(&embedding));
        }
    }

    Ok((face_count, face_fingerprints))
}

/// Runs the Facenet512 embedding model on a cropped face, returning its 512-d L2-normalized
/// embedding vector. Used purely for identity fingerprinting, not stored as raw data.
///
/// Input layout is NHWC (`1x160x160x3`), matching `models/export_facenet_onnx.py`'s
/// channels-last Keras export.
fn compute_face_embedding(models: &VisionModels, face: &DynamicImage) -> Result<Vec<f32>, String> {
    const FACE_SIZE: u32 = 160;

    let Some(embedding_session) = &models.embedding_session else {
        return Err("embedding model not available".to_string());
    };

    let resized = face.resize_exact(FACE_SIZE, FACE_SIZE, FilterType::Triangle).to_rgb8();
    // FaceNet-style "prewhiten" normalization.
    let mut hwc = Array3::<f32>::zeros((FACE_SIZE as usize, FACE_SIZE as usize, 3));
    for y in 0..FACE_SIZE {
        for x in 0..FACE_SIZE {
            let pixel = resized.get_pixel(x, y);
            for c in 0..3 {
                hwc[[y as usize, x as usize, c]] = (pixel[c] as f32 - 127.5) / 128.0;
            }
        }
    }
    let input = Tensor::from_array(hwc.insert_axis(Axis(0))).map_err(|e| e.to_string())?;

    let mut session = embedding_session.lock().map_err(|_| "embedding session lock poisoned".to_string())?;
    let outputs = session.run(ort::inputs!["input" => input]).map_err(|e| e.to_string())?;
    let embedding = outputs[0].try_extract_array::<f32>().map_err(|e| e.to_string())?;
    let embedding: Vec<f32> = embedding.iter().copied().collect();
    drop(outputs);
    drop(session);

    let norm = embedding.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        Ok(embedding.iter().map(|v| v / norm).collect())
    } else {
        Ok(embedding)
    }
}

/// Buckets a face embedding into a stable identity fingerprint using random-hyperplane LSH
/// (SimHash): faces with similar (cosine-close) embeddings hash to the same or nearby buckets,
/// without needing a persisted embedding database.
fn face_fingerprint(embedding: &[f32]) -> String {
    const HASH_BITS: u32 = 64;

    let mut hash: u64 = 0;
    for bit in 0..HASH_BITS {
        let projection: f32 = embedding
            .iter()
            .enumerate()
            .map(|(dim, value)| value * lsh_hyperplane_component(bit, dim as u32))
            .sum();
        if projection > 0.0 {
            hash |= 1 << bit;
        }
    }
    format!("face_cluster_{hash:016x}")
}

/// Deterministic pseudo-random value in [-1, 1] for hyperplane `bit`'s component along
/// embedding dimension `dim`, used by `face_fingerprint`. Uses a fixed seed so the same
/// embedding always hashes to the same fingerprint across runs.
fn lsh_hyperplane_component(bit: u32, dim: u32) -> f32 {
    let mut x = (bit as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ (dim as u64).wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51AFD7ED558CCD);
    x ^= x >> 33;
    x = x.wrapping_mul(0xC4CEB9FE1A85EC53);
    x ^= x >> 33;
    ((x as f64 / u64::MAX as f64) * 2.0 - 1.0) as f32
}

/// The 80-class MS COCO label map used by Ultralytics YOLOv8 (indices 0..=79, no gaps).
fn coco80_label(id: u32) -> Option<&'static str> {
    const LABELS: [&str; 80] = [
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
        "traffic_light", "fire_hydrant", "stop_sign", "parking_meter", "bench", "bird", "cat",
        "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
        "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports_ball",
        "kite", "baseball_bat", "baseball_glove", "skateboard", "surfboard", "tennis_racket",
        "bottle", "wine_glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
        "sandwich", "orange", "broccoli", "carrot", "hot_dog", "pizza", "donut", "cake", "chair",
        "couch", "potted_plant", "bed", "dining_table", "toilet", "tv", "laptop", "mouse",
        "remote", "keyboard", "cell_phone", "microwave", "oven", "toaster", "sink", "refrigerator",
        "book", "clock", "vase", "scissors", "teddy_bear", "hair_drier", "toothbrush",
    ];
    LABELS.get(id as usize).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    // Requires MODELS_DIR to point at a directory containing the real ONNX models;
    // run with `MODELS_DIR=./models cargo test -- --ignored` to exercise the full pipeline.
    #[test]
    #[ignore]
    fn analyze_runs_end_to_end_without_panicking() {
        let mut buf = RgbImage::new(300, 300);
        for (x, y, pixel) in buf.enumerate_pixels_mut() {
            *pixel = if (x / 20 + y / 20) % 2 == 0 { Rgb([200, 40, 40]) } else { Rgb([30, 30, 200]) };
        }
        let img = DynamicImage::ImageRgb8(buf);

        let result = analyze(&img);
        println!(
            "objects={:?} face_count={} fingerprints={:?}",
            result.object_tags, result.face_count, result.face_fingerprints
        );
    }

    #[test]
    #[ignore]
    fn analyze_real_photo_manual_check() {
        let path = std::env::var("TEST_IMAGE").expect("set TEST_IMAGE to a real photo path");
        let img = image::open(path).expect("failed to open TEST_IMAGE");
        let result = analyze(&img);
        println!(
            "objects={:?} face_count={} fingerprints={:?}",
            result.object_tags, result.face_count, result.face_fingerprints
        );
    }

    #[test]
    fn face_fingerprint_is_deterministic_and_distinguishes_embeddings() {
        let a = vec![0.1_f32; 512];
        let b = vec![-0.1_f32; 512];
        assert_eq!(face_fingerprint(&a), face_fingerprint(&a));
        assert_ne!(face_fingerprint(&a), face_fingerprint(&b));
    }
}
