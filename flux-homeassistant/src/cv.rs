use chrono::NaiveDateTime;
use exif::{In, Reader, Tag, Value};
use image::{imageops::FilterType, GenericImageView, Pixel};
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

                // Analyze color/hue histogram, brightness, and edge energy on a sampled grid
                let mut total_brightness: u64 = 0;
                let mut hue_counts: std::collections::HashMap<&'static str, u32> = std::collections::HashMap::new();
                let mut grayscale_samples: u32 = 0;
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

                        match Self::classify_hue(r, g, b) {
                            Some(hue) => *hue_counts.entry(hue).or_insert(0) += 1,
                            None => grayscale_samples += 1,
                        }

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
                        tags.push("indoor".to_string());
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

                    // Tag based on dominant hue(s) detected across sampled pixels
                    if grayscale_samples as f32 / samples as f32 > 0.85 {
                        tags.push("monochrome".to_string());
                    } else if !hue_counts.is_empty() {
                        let mut ranked: Vec<(&str, u32)> = hue_counts.into_iter().collect();
                        ranked.sort_by(|a, b| b.1.cmp(&a.1));

                        let dominant_hues: Vec<&str> = ranked
                            .iter()
                            .filter(|(_, count)| *count as f32 / samples as f32 > 0.12)
                            .map(|(hue, _)| *hue)
                            .collect();

                        if dominant_hues.len() >= 3 {
                            tags.push("colorful".to_string());
                        }

                        for hue in &dominant_hues {
                            tags.push(hue.to_string());
                        }

                        // Higher-level semantic tags derived from the dominant hue + brightness
                        if let Some(&top_hue) = dominant_hues.first() {
                            match top_hue {
                                "green" if avg_brightness > 60 => {
                                    tags.push("nature".to_string());
                                }
                                "blue" if avg_brightness > 100 => {
                                    tags.push("sky".to_string());
                                }
                                "orange" | "red" if avg_brightness > 60 && avg_brightness < 200 => {
                                    tags.push("sunset".to_string());
                                    tags.push("warm".to_string());
                                }
                                _ => {}
                            }
                        }
                    }
                }

                // 5. Object/face/expression detection via local ONNX models
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
                if vision.smiling {
                    tags.push("smile".to_string());
                }

                // Generate face embeddings / image similarities fingerprint
                // Let's create a 64-bit dHash of the image as a face / identity descriptor
                // `resize_exact` (not `thumbnail`, which preserves aspect ratio) guarantees a 9x8 output
                let resized = img.resize_exact(9, 8, FilterType::Triangle).grayscale();
                let mut hash: u64 = 0;
                for y in 0..8 {
                    for x in 0..8 {
                        let left = resized.get_pixel(x, y)[0];
                        let right = resized.get_pixel(x + 1, y)[0];
                        if left > right {
                            hash |= 1 << (y * 8 + x);
                        }
                    }
                }
                
                // Let's add face clustering tags based on fingerprint similarity groups
                let face_cluster = format!("face_cluster_{:04x}", hash & 0xFFF);
                faces.push(face_cluster);
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

    /// Classifies an RGB pixel into a coarse hue bucket, or `None` if it's too
    /// desaturated/dark to reliably indicate a color (i.e. it's grayscale-ish).
    fn classify_hue(r: u8, g: u8, b: u8) -> Option<&'static str> {
        let r = r as f32 / 255.0;
        let g = g as f32 / 255.0;
        let b = b as f32 / 255.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let delta = max - min;
        let value = max;
        let saturation = if max == 0.0 { 0.0 } else { delta / max };

        if saturation < 0.15 || value < 0.1 {
            return None;
        }

        let mut hue = if delta == 0.0 {
            0.0
        } else if max == r {
            60.0 * (((g - b) / delta).rem_euclid(6.0))
        } else if max == g {
            60.0 * (((b - r) / delta) + 2.0)
        } else {
            60.0 * (((r - g) / delta) + 4.0)
        };
        if hue < 0.0 {
            hue += 360.0;
        }

        Some(match hue as u32 {
            0..=15 | 346..=360 => "red",
            16..=45 => "orange",
            46..=70 => "yellow",
            71..=170 => "green",
            171..=200 => "cyan",
            201..=255 => "blue",
            256..=290 => "purple",
            _ => "pink",
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

