use chrono::NaiveDateTime;
use exif::{In, Reader, Tag, Value};
use image::{GenericImageView, Pixel};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct ImageAnalysisResult {
    pub tags: Vec<String>,
    pub faces: Vec<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub date_created: Option<i64>,
}

pub struct CvPipeline;

impl CvPipeline {
    /// Full image analysis pipeline: EXIF + Color Profiling + Face fingerprinting + Filename tagging
    pub fn analyze_image(file_path: &Path) -> Result<ImageAnalysisResult, String> {
        info!("Running vision and metadata pipeline on {:?}", file_path);

        // 1. Initialize with default values
        let mut latitude = None;
        let mut longitude = None;
        let mut date_created = None;
        let mut tags = Vec::new();
        let mut faces = Vec::new();

        // 2. Parse EXIF data
        if let Ok(file) = File::open(file_path) {
            let mut buf_reader = BufReader::new(file);
            let reader = Reader::new();
            if let Ok(exif_data) = reader.read_from_container(&mut buf_reader) {
                // Parse Lat/Lon
                if let Some(lat_field) = exif_data.get_field(Tag::GPSLatitude, In::PRIMARY) {
                    if let Some(ref_field) = exif_data.get_field(Tag::GPSLatitudeRef, In::PRIMARY) {
                        let ref_str = ref_field.value.display_as(Tag::GPSLatitudeRef).to_string();
                        if let Some(lat_val) = Self::parse_gps_coord(&lat_field.value, &ref_str) {
                            latitude = Some(lat_val);
                        }
                    }
                }

                if let Some(lon_field) = exif_data.get_field(Tag::GPSLongitude, In::PRIMARY) {
                    if let Some(ref_field) = exif_data.get_field(Tag::GPSLongitudeRef, In::PRIMARY) {
                        let ref_str = ref_field.value.display_as(Tag::GPSLongitudeRef).to_string();
                        if let Some(lon_val) = Self::parse_gps_coord(&lon_field.value, &ref_str) {
                            longitude = Some(lon_val);
                        }
                    }
                }

                // Parse Capture Date
                if let Some(date_field) = exif_data.get_field(Tag::DateTimeOriginal, In::PRIMARY) {
                    date_created = Self::parse_exif_date(&date_field.value);
                } else if let Some(date_field) = exif_data.get_field(Tag::DateTime, In::PRIMARY) {
                    date_created = Self::parse_exif_date(&date_field.value);
                }
            }
        }

        // Use system file creation/modified date if EXIF date is missing
        if date_created.is_none() {
            if let Ok(metadata) = fs::metadata(file_path) {
                if let Ok(system_time) = metadata.created().or_else(|_| metadata.modified()) {
                    if let Ok(duration) = system_time.duration_since(std::time::UNIX_EPOCH) {
                        date_created = Some(duration.as_secs() as i64);
                    }
                }
            }
        }

        // 3. Filename/path rule-based tagging
        if let Some(file_name) = file_path.file_name().and_then(|n| n.to_str()) {
            let lower_name = file_name.to_lowercase();
            let keywords = vec![
                "dog", "cat", "car", "receipt", "invoice", "document", "screenshot", 
                "house", "garden", "outdoor", "indoor", "family", "vacation", "trip"
            ];
            for kw in keywords {
                if lower_name.contains(kw) {
                    tags.push(kw.to_string());
                }
            }
        }

        // 4. Visual analysis using the `image` crate (Color, Brightness, similarity fingerprint)
        match image::open(file_path) {
            Ok(img) => {
                let (width, height) = img.dimensions();

                // If it looks like a long vertical document, tag it as receipt/document
                let ratio = height as f32 / width as f32;
                if ratio > 2.2 && width < 1200 {
                    tags.push("receipt".to_string());
                    tags.push("document".to_string());
                }

                // Orientation & resolution tags
                if width > height {
                    tags.push("landscape_orientation".to_string());
                } else if height > width {
                    tags.push("portrait_orientation".to_string());
                } else {
                    tags.push("square_orientation".to_string());
                }
                let megapixels = (width as u64 * height as u64) as f64 / 1_000_000.0;
                if megapixels >= 8.0 {
                    tags.push("high_resolution".to_string());
                } else if megapixels < 0.3 {
                    tags.push("low_resolution".to_string());
                }

                // Analyze brightness and edge energy on a sampled grid (structural heuristics only;
                // color/hue is intentionally not used to guess scene content like "sunset"/"nature")
                let mut total_brightness: u64 = 0;
                let mut edge_energy: u64 = 0;
                let mut edge_pairs: u32 = 0;
                let sample_step = 10;
                let mut samples: u64 = 0;

                for y in (0..height).step_by(sample_step as usize) {
                    let mut prev_brightness: Option<i64> = None;
                    for x in (0..width).step_by(sample_step as usize) {
                        let pixel = img.get_pixel(x, y);
                        let rgb = pixel.to_rgb();
                        let (r, g, b) = (rgb[0], rgb[1], rgb[2]);

                        // Perceptual brightness formula
                        let brightness = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32) as i64;
                        total_brightness += brightness as u64;
                        samples += 1;

                        // Edge energy: squared brightness delta between horizontally adjacent samples
                        if let Some(prev) = prev_brightness {
                            let delta = brightness - prev;
                            edge_energy += (delta * delta) as u64;
                            edge_pairs += 1;
                        }
                        prev_brightness = Some(brightness);
                    }
                }

                if samples > 0 {
                    let avg_brightness = total_brightness.checked_div(samples).unwrap_or_default();

                    // Tag based on brightness
                    if avg_brightness < 50 {
                        tags.push("night".to_string());
                        tags.push("dark".to_string());
                    } else if avg_brightness > 200 {
                        tags.push("bright".to_string());
                    }

                    // Tag based on sharpness: low variance in local brightness deltas means a blurry image
                    if edge_pairs > 0 {
                        let avg_edge_energy = edge_energy / edge_pairs as u64;
                        if avg_edge_energy < 8 {
                            tags.push("blurry".to_string());
                        } else if avg_edge_energy > 400 {
                            tags.push("sharp".to_string());
                        }
                    }
                }

                // 5. Object/face detection + facial fingerprinting via local ONNX models
                // (YOLOv8 for objects/faces, Facenet512 for identity fingerprints)
                let vision = crate::detect::analyze(&img);
                for tag in vision.object_tags {
                    tags.push(tag);
                }
                if vision.face_count == 1 {
                    tags.push("person".to_string());
                    tags.push("face".to_string());
                } else if vision.face_count > 1 {
                    tags.push("people".to_string());
                    tags.push("face".to_string());
                }
                faces.extend(vision.face_fingerprints);
            }
            Err(e) => {
                warn!("Image processing failed for {:?}, skipping visual tags: {}", file_path, e);
            }
        }

        // De-duplicate tags
        tags.sort();
        tags.dedup();

        Ok(ImageAnalysisResult {
            tags,
            faces,
            latitude,
            longitude,
            date_created,
        })
    }

    /// Converts EXIF Rational values into decimal coordinates
    fn parse_gps_coord(value: &Value, ref_str: &str) -> Option<f64> {
        if let Value::Rational(ref rationals) = value {
            if rationals.len() >= 3 {
                let deg = rationals[0].to_f32() as f64;
                let min = rationals[1].to_f32() as f64;
                let sec = rationals[2].to_f32() as f64;

                let mut decimal = deg + (min / 60.0) + (sec / 3600.0);
                let cleaned_ref = ref_str.trim().to_uppercase();
                if cleaned_ref.contains('S') || cleaned_ref.contains('W') {
                    decimal = -decimal;
                }
                return Some(decimal);
            }
        }
        None
    }

    /// Converts EXIF ASCII date into Unix epoch timestamp
    fn parse_exif_date(value: &Value) -> Option<i64> {
        if let Value::Ascii(ref ascii_vec) = value {
            for bytes in ascii_vec {
                if let Ok(date_str) = std::str::from_utf8(bytes) {
                    let cleaned = date_str.trim();
                    // EXIF date format: "YYYY:MM:DD HH:MM:SS"
                    if let Ok(naive_dt) = NaiveDateTime::parse_from_str(cleaned, "%Y:%m:%d %H:%M:%S") {
                        return Some(naive_dt.and_utc().timestamp());
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gps_coord() {
        // Test positive coordinates (e.g. North 37 deg 46 min 30 sec)
        let val = Value::Rational(vec![
            exif::Rational { num: 37, denom: 1 },
            exif::Rational { num: 46, denom: 1 },
            exif::Rational { num: 30, denom: 1 },
        ]);
        let coord = CvPipeline::parse_gps_coord(&val, "N").unwrap();
        assert!((coord - 37.775).abs() < 0.001);

        // Test negative coordinates (e.g. West 122 deg 25 min 6 sec)
        let val2 = Value::Rational(vec![
            exif::Rational { num: 122, denom: 1 },
            exif::Rational { num: 25, denom: 1 },
            exif::Rational { num: 6, denom: 1 },
        ]);
        let coord2 = CvPipeline::parse_gps_coord(&val2, "W").unwrap();
        assert!((coord2 - (-122.4183)).abs() < 0.001);
    }

    #[test]
    fn test_parse_exif_date() {
        let val = Value::Ascii(vec![b"2023:07:23 15:45:00".to_vec()]);
        let ts = CvPipeline::parse_exif_date(&val).unwrap();
        // 2023-07-23 15:45:00 UTC = 1690127100
        assert_eq!(ts, 1690127100);
    }
}

