#!/bin/sh
# Downloads the pretrained ONNX models used by src/detect.rs for offline object/face/
# expression detection. Run this once for local development (`cargo test`/`cargo run`
# read models from ./models by default); the Docker build runs it automatically.
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"

fetch() {
    name="$1"
    url="$2"
    if [ -f "$name" ]; then
        echo "Skipping $name (already present)"
        return
    fi
    echo "Downloading $name..."
    curl -sL --fail --retry 3 -o "$name" "$url"
}

# General object detection (COCO 90-class SSD-MobileNetV1), from the ONNX Model Zoo.
fetch ssd_mobilenet_v1_10.onnx \
    "https://github.com/onnx/models/raw/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1/model/ssd_mobilenet_v1_10.onnx"

# Lightweight face detector (Ultra-Light-Fast-Generic-Face-Detector-1MB), from the ONNX Model Zoo.
fetch version-RFB-320.onnx \
    "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx"

# Facial expression classifier (FER+), from the ONNX Model Zoo.
fetch emotion-ferplus-8.onnx \
    "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx"

echo "All vision models present in $DIR"
