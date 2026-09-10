#!/usr/bin/env python3
"""One-off helper to produce facenet512.onnx for src/detect.rs's facial fingerprinting.

DeepFace ships its "Facenet512" weights as a Keras/TensorFlow model (downloaded internally
by the `deepface` package from its own official release assets), so we load it through
DeepFace and convert it to ONNX locally with tf2onnx rather than hardcoding a raw download
URL for an ONNX file that may not exist anywhere stable.

Usage:
    pip install deepface tf2onnx tensorflow tf-keras
    python3 models/export_facenet_onnx.py
    # -> writes models/facenet512.onnx (input "input": 1x160x160x3 RGB, output: 1x512 embedding)

Note the input layout here is NHWC (channels-last), matching Keras' default. src/detect.rs
builds a CHW tensor for other models but must transpose to NHWC before calling this one -
adjust detect.rs's `compute_face_embedding` input tensor layout if you regenerate this file
with a different export configuration.
"""
import os

import tf2onnx
import tensorflow as tf
from deepface.DeepFace import build_model

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "facenet512.onnx")


def main() -> None:
    facial_recognition_model = build_model("Facenet512")
    keras_model = facial_recognition_model.model

    input_signature = [tf.TensorSpec([1, 160, 160, 3], tf.float32, name="input")]
    onnx_model, _ = tf2onnx.convert.from_keras(
        keras_model, input_signature=input_signature, opset=12, output_path=OUTPUT_PATH
    )
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
