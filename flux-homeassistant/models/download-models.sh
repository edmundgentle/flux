#!/bin/sh
# Downloads/exports the pretrained ONNX models used by src/detect.rs for offline object/face
# detection and facial fingerprinting. Run this once for local development (`cargo test`/
# `cargo run` read models from ./models by default); the Docker build runs it automatically.
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"

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

# Face detection: a community YOLOv8 checkpoint fine-tuned for faces, resolved via the
# Hugging Face Hub client (not a hardcoded raw URL) so this fails loudly if the repo ever
# moves/disappears instead of silently fetching the wrong thing.
if [ -f yolov8n-face.onnx ]; then
    echo "Skipping yolov8n-face.onnx (already present)"
elif command -v python3 >/dev/null 2>&1; then
    echo "Exporting yolov8n-face.onnx via arnabdhar/YOLOv8-Face-Detection (Hugging Face Hub)..."
    python3 -m pip install --quiet --disable-pip-version-check --break-system-packages huggingface_hub \
        && FACE_PT="$(python3 -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(repo_id='arnabdhar/YOLOv8-Face-Detection', filename='model.pt'))")" \
        && python3 -c "from ultralytics import YOLO; YOLO('$FACE_PT').export(format='onnx', opset=12)" \
        && mv -f "$(dirname "$FACE_PT")/model.onnx" yolov8n-face.onnx \
        || true
    if [ ! -f yolov8n-face.onnx ]; then
        echo "WARNING: failed to export yolov8n-face.onnx automatically. Face detection will be" >&2
        echo "skipped until you place a valid yolov8n-face.onnx in $DIR." >&2
    fi
else
    echo "WARNING: python3 not found, cannot export yolov8n-face.onnx automatically." >&2
fi

# Facial fingerprinting: DeepFace's Facenet512 embedding model. DeepFace/tf2onnx/tensorflow are
# only needed for this one-off local export, so this is intentionally not run automatically in
# CI/Docker builds (see models/export_facenet_onnx.py) — it's heavy (installs TensorFlow) and
# only needs to run once, with the resulting .onnx file cached in $DIR afterwards.
if [ ! -f facenet512.onnx ]; then
    echo "WARNING: facenet512.onnx not found. Facial fingerprinting will be skipped." >&2
    echo "Generate it once locally with 'models/export_facenet_onnx.py' (see that file for" >&2
    echo "required pip packages), then save the result as $DIR/facenet512.onnx." >&2
fi

echo "Vision model setup complete in $DIR (see warnings above for anything missing)"

