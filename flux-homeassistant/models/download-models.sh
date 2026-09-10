#!/bin/sh
# Downloads/exports the pretrained ONNX models used by src/detect.rs for offline object/face
# detection and facial fingerprinting. Run this once for local development (`cargo test`/
# `cargo run` read models from ./models by default); the Docker build runs it automatically.
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

# General object detection (Ultralytics YOLOv8n, COCO 80-class), exported to ONNX via the
# official `ultralytics` package, which downloads yolov8n.pt from Ultralytics' own release
# assets internally.
if [ -f yolov8n.onnx ]; then
    echo "Skipping yolov8n.onnx (already present)"
elif command -v python3 >/dev/null 2>&1; then
    echo "Exporting yolov8n.onnx via ultralytics..."
    python3 -m pip install --quiet --disable-pip-version-check --break-system-packages ultralytics \
        && python3 -c "from ultralytics import YOLO; YOLO('yolov8n.pt').export(format='onnx', opset=12)" \
        || true
    if [ ! -f yolov8n.onnx ]; then
        echo "WARNING: failed to export yolov8n.onnx automatically. Object detection will be" >&2
        echo "skipped until you place a valid yolov8n.onnx in $DIR." >&2
    fi
else
    echo "WARNING: python3 not found, cannot export yolov8n.onnx automatically." >&2
    echo "Install python3 + 'pip install ultralytics', then run:" >&2
    echo "  yolo export model=yolov8n.pt format=onnx opset=12" >&2
    echo "and place the resulting yolov8n.onnx in $DIR." >&2
fi

# Face detection (Ultralytics YOLOv8 fine-tuned for faces) and facial fingerprinting
# (DeepFace's Facenet512 embedding model) don't have a single official, stable direct-download
# URL we can safely hardcode here. Rather than guess one, we check for the files and print
# manual instructions if they're missing so the rest of the pipeline still runs without them.
if [ ! -f yolov8n-face.onnx ]; then
    echo "WARNING: yolov8n-face.onnx not found. Face detection will be skipped." >&2
    echo "Obtain/train a YOLOv8 face-detection checkpoint of your choosing, export it with:" >&2
    echo "  yolo export model=<your-face-checkpoint>.pt format=onnx opset=12" >&2
    echo "and save the result as $DIR/yolov8n-face.onnx." >&2
fi

if [ ! -f facenet512.onnx ]; then
    echo "WARNING: facenet512.onnx not found. Facial fingerprinting will be skipped." >&2
    echo "Generate it once locally with 'models/export_facenet_onnx.py' (see that file for" >&2
    echo "required pip packages), then save the result as $DIR/facenet512.onnx." >&2
fi

# Facial expression classifier (FER+), from the ONNX Model Zoo. Still used to flag smiling faces.
fetch emotion-ferplus-8.onnx \
    "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx"

echo "Vision model setup complete in $DIR (see warnings above for anything missing)"

