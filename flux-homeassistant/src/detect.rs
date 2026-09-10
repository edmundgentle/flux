//! Local, offline object/face/expression detection powered by ONNX Runtime (`ort`).
//!
//! Three small pretrained models are used:
//! - `ssd_mobilenet_v1_10.onnx` — general object detection (COCO 90-class label map)
//! - `version-RFB-320.onnx` — lightweight face detector (Ultra-Light-Fast-Generic-Face-Detector)
//! - `emotion-ferplus-8.onnx` — facial expression classifier (FER+, 8 emotion classes)
//!
//! Models are loaded once (lazily, on first use) from the directory pointed to by the
//! `MODELS_DIR` env var (default `/app/models`). If the models are missing or fail to
//! load, detection is silently skipped so the rest of the CV pipeline still runs.

use image::{imageops::FilterType, DynamicImage, GenericImageView};
use ndarray::{Array3, Array4};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tracing::warn;

pub struct VisionResult {
    pub object_tags: Vec<String>,
    pub face_count: usize,
    pub smiling: bool,
}

struct VisionModels {
    object_session: Mutex<Session>,
    face_session: Mutex<Session>,
    emotion_session: Mutex<Session>,
}

static VISION_MODELS: OnceLock<Option<VisionModels>> = OnceLock::new();

fn models_dir() -> PathBuf {
    std::env::var("MODELS_DIR").unwrap_or_else(|_| "/app/models".to_string()).into()
}

fn load_session(dir: &Path, file_name: &str) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .commit_from_file(dir.join(file_name))
        .map_err(|e| format!("failed to load {file_name}: {e}"))
}

fn get_models() -> Option<&'static VisionModels> {
    VISION_MODELS
        .get_or_init(|| {
            let dir = models_dir();
            let load = || -> Result<VisionModels, String> {
                Ok(VisionModels {
                    object_session: Mutex::new(load_session(&dir, "ssd_mobilenet_v1_10.onnx")?),
                    face_session: Mutex::new(load_session(&dir, "version-RFB-320.onnx")?),
                    emotion_session: Mutex::new(load_session(&dir, "emotion-ferplus-8.onnx")?),
                })
            };
            match load() {
                Ok(models) => Some(models),
                Err(e) => {
                    warn!("Vision models unavailable in {:?}, skipping object/face detection: {}", dir, e);
                    None
                }
            }
        })
        .as_ref()
}

/// Runs object detection + face/expression analysis on an already-decoded image.
/// Returns an empty/default result (never an error) if models aren't available.
pub fn analyze(img: &DynamicImage) -> VisionResult {
    let Some(models) = get_models() else {
        return VisionResult { object_tags: Vec::new(), face_count: 0, smiling: false };
    };

    let object_tags = detect_objects(models, img).unwrap_or_else(|e| {
        warn!("Object detection failed: {}", e);
        Vec::new()
    });

    let (face_count, smiling) = detect_faces(models, img).unwrap_or_else(|e| {
        warn!("Face/expression detection failed: {}", e);
        (0, false)
    });

    VisionResult { object_tags, face_count, smiling }
}

fn detect_objects(models: &VisionModels, img: &DynamicImage) -> Result<Vec<String>, String> {
    let rgb = img.to_rgb8();
    let (width, height) = rgb.dimensions();
    let data = rgb.into_raw();
    let tensor = Array4::from_shape_vec((1, height as usize, width as usize, 3), data)
        .map_err(|e| e.to_string())?;

    let tensor = Tensor::from_array(tensor).map_err(|e| e.to_string())?;
    let mut session = models.object_session.lock().map_err(|_| "object session lock poisoned".to_string())?;
    let outputs = session
        .run(ort::inputs!["image_tensor:0" => tensor])
        .map_err(|e| e.to_string())?;

    let num_detections = outputs["num_detections:0"]
        .try_extract_array::<f32>()
        .map_err(|e| e.to_string())?;
    let scores = outputs["detection_scores:0"]
        .try_extract_array::<f32>()
        .map_err(|e| e.to_string())?;
    let classes = outputs["detection_classes:0"]
        .try_extract_array::<f32>()
        .map_err(|e| e.to_string())?;

    let count = num_detections.iter().next().copied().unwrap_or(0.0) as usize;
    let scores = scores.as_slice().ok_or("unexpected scores layout")?;
    let classes = classes.as_slice().ok_or("unexpected classes layout")?;

    const CONFIDENCE_THRESHOLD: f32 = 0.5;
    let mut tags = Vec::new();
    for i in 0..count.min(scores.len()).min(classes.len()) {
        if scores[i] < CONFIDENCE_THRESHOLD {
            continue;
        }
        if let Some(label) = coco_label(classes[i].round() as u32) {
            if !tags.contains(&label.to_string()) {
                tags.push(label.to_string());
            }
        }
    }
    Ok(tags)
}

/// Detects faces and, for each, classifies its expression; returns (face_count, any_smiling).
fn detect_faces(models: &VisionModels, img: &DynamicImage) -> Result<(usize, bool), String> {
    const FACE_INPUT_WIDTH: u32 = 320;
    const FACE_INPUT_HEIGHT: u32 = 240;
    const FACE_CONFIDENCE_THRESHOLD: f32 = 0.7;
    const IOU_THRESHOLD: f32 = 0.5;
    const MAX_FACES_TO_CLASSIFY: usize = 5;

    let (orig_width, orig_height) = img.dimensions();
    let resized = img.resize_exact(FACE_INPUT_WIDTH, FACE_INPUT_HEIGHT, FilterType::Triangle).to_rgb8();

    let mut chw = Array3::<f32>::zeros((3, FACE_INPUT_HEIGHT as usize, FACE_INPUT_WIDTH as usize));
    for y in 0..FACE_INPUT_HEIGHT {
        for x in 0..FACE_INPUT_WIDTH {
            let pixel = resized.get_pixel(x, y);
            for c in 0..3 {
                chw[[c, y as usize, x as usize]] = (pixel[c] as f32 - 127.0) / 128.0;
            }
        }
    }
    let input = chw.insert_axis(ndarray::Axis(0));
    let input = Tensor::from_array(input).map_err(|e| e.to_string())?;

    let mut face_session = models.face_session.lock().map_err(|_| "face session lock poisoned".to_string())?;
    let outputs = face_session
        .run(ort::inputs!["input" => input])
        .map_err(|e| e.to_string())?;

    let scores = outputs["scores"].try_extract_array::<f32>().map_err(|e| e.to_string())?;
    let boxes = outputs["boxes"].try_extract_array::<f32>().map_err(|e| e.to_string())?;

    let scores: Vec<f32> = scores.as_slice().ok_or("unexpected face scores layout")?.to_vec();
    let boxes: Vec<f32> = boxes.as_slice().ok_or("unexpected face boxes layout")?.to_vec();
    drop(outputs);
    drop(face_session);

    // scores is [N, 2] (background, face); boxes is [N, 4] (x1, y1, x2, y2), normalized 0..1
    let num_candidates = scores.len() / 2;
    let mut candidates: Vec<(f32, [f32; 4])> = Vec::new();
    for i in 0..num_candidates {
        let face_score = scores[i * 2 + 1];
        if face_score >= FACE_CONFIDENCE_THRESHOLD {
            let b = [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]];
            candidates.push((face_score, b));
        }
    }

    let kept = non_max_suppression(candidates, IOU_THRESHOLD);
    let face_count = kept.len();

    let mut smiling = false;
    for (_, b) in kept.iter().take(MAX_FACES_TO_CLASSIFY) {
        let x1 = (b[0] * orig_width as f32).max(0.0) as u32;
        let y1 = (b[1] * orig_height as f32).max(0.0) as u32;
        let x2 = (b[2] * orig_width as f32).min(orig_width as f32) as u32;
        let y2 = (b[3] * orig_height as f32).min(orig_height as f32) as u32;
        if x2 <= x1 || y2 <= y1 {
            continue;
        }

        let crop = img.crop_imm(x1, y1, x2 - x1, y2 - y1);
        if classify_smile(models, &crop)? {
            smiling = true;
        }
    }

    Ok((face_count, smiling))
}

/// Runs the FER+ emotion model on a cropped face and returns true if "happiness" is the
/// dominant expression.
fn classify_smile(models: &VisionModels, face: &DynamicImage) -> Result<bool, String> {
    let gray = face.resize_exact(64, 64, FilterType::Triangle).to_luma8();
    let data: Vec<f32> = gray.into_raw().into_iter().map(|p| p as f32).collect();
    let input = Array4::from_shape_vec((1, 1, 64, 64), data).map_err(|e| e.to_string())?;
    let input = Tensor::from_array(input).map_err(|e| e.to_string())?;

    let mut emotion_session = models.emotion_session.lock().map_err(|_| "emotion session lock poisoned".to_string())?;
    let outputs = emotion_session
        .run(ort::inputs!["Input3" => input])
        .map_err(|e| e.to_string())?;
    let logits = outputs["Plus692_Output_0"].try_extract_array::<f32>().map_err(|e| e.to_string())?;
    let logits = logits.as_slice().ok_or("unexpected emotion output layout")?;

    // FER+ classes: 0=neutral 1=happiness 2=surprise 3=sadness 4=anger 5=disgust 6=fear 7=contempt
    let probs = softmax(logits);
    let (top_idx, &top_prob) = probs
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .ok_or("empty emotion output")?;

    Ok(top_idx == 1 && top_prob > 0.4)
}

fn softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|v| (v - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    exps.iter().map(|v| v / sum).collect()
}

/// Greedy non-max suppression over (score, [x1,y1,x2,y2]) boxes.
fn non_max_suppression(mut candidates: Vec<(f32, [f32; 4])>, iou_threshold: f32) -> Vec<(f32, [f32; 4])> {
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<(f32, [f32; 4])> = Vec::new();
    for candidate in candidates {
        if kept.iter().all(|k| iou(&k.1, &candidate.1) < iou_threshold) {
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

/// The 90-class MS COCO label map used by the TF Object Detection API (and thus this SSD model).
/// Note: ids 12, 26, 29, 30, 45, 66, 68, 69, 71, and 83 are intentionally unused gaps.
fn coco_label(id: u32) -> Option<&'static str> {
    Some(match id {
        1 => "person",
        2 => "bicycle",
        3 => "car",
        4 => "motorcycle",
        5 => "airplane",
        6 => "bus",
        7 => "train",
        8 => "truck",
        9 => "boat",
        10 => "traffic_light",
        11 => "fire_hydrant",
        13 => "stop_sign",
        14 => "parking_meter",
        15 => "bench",
        16 => "bird",
        17 => "cat",
        18 => "dog",
        19 => "horse",
        20 => "sheep",
        21 => "cow",
        22 => "elephant",
        23 => "bear",
        24 => "zebra",
        25 => "giraffe",
        27 => "backpack",
        28 => "umbrella",
        31 => "handbag",
        32 => "tie",
        33 => "suitcase",
        34 => "frisbee",
        35 => "skis",
        36 => "snowboard",
        37 => "sports_ball",
        38 => "kite",
        39 => "baseball_bat",
        40 => "baseball_glove",
        41 => "skateboard",
        42 => "surfboard",
        43 => "tennis_racket",
        44 => "bottle",
        46 => "wine_glass",
        47 => "cup",
        48 => "fork",
        49 => "knife",
        50 => "spoon",
        51 => "bowl",
        52 => "banana",
        53 => "apple",
        54 => "sandwich",
        55 => "orange",
        56 => "broccoli",
        57 => "carrot",
        58 => "hot_dog",
        59 => "pizza",
        60 => "donut",
        61 => "cake",
        62 => "chair",
        63 => "couch",
        64 => "potted_plant",
        65 => "bed",
        67 => "dining_table",
        70 => "toilet",
        72 => "tv",
        73 => "laptop",
        74 => "mouse",
        75 => "remote",
        76 => "keyboard",
        77 => "cell_phone",
        78 => "microwave",
        79 => "oven",
        80 => "toaster",
        81 => "sink",
        82 => "refrigerator",
        84 => "book",
        85 => "clock",
        86 => "vase",
        87 => "scissors",
        88 => "teddy_bear",
        89 => "hair_drier",
        90 => "toothbrush",
        _ => return None,
    })
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
            "objects={:?} face_count={} smiling={}",
            result.object_tags, result.face_count, result.smiling
        );
    }

    #[test]
    #[ignore]
    fn analyze_real_photo_manual_check() {
        let path = std::env::var("TEST_IMAGE").expect("set TEST_IMAGE to a real photo path");
        let img = image::open(path).expect("failed to open TEST_IMAGE");
        let result = analyze(&img);
        println!(
            "objects={:?} face_count={} smiling={}",
            result.object_tags, result.face_count, result.smiling
        );
    }
}
