#!/usr/bin/env python3
import argparse
import json
import time
from pathlib import Path

import cv2
import torch
from ultralytics import YOLO


def main() -> None:
    parser = argparse.ArgumentParser(description="Run outfall YOLO detection for one capture image.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()

    model_path = Path(args.model)
    image_path = Path(args.image)
    output_path = Path(args.output)
    device = "cuda:0" if torch.cuda.is_available() else "cpu"

    started = time.perf_counter()
    model = YOLO(str(model_path))
    results = model.predict(source=str(image_path), conf=args.conf, device=device, verbose=False)
    inference_ms = (time.perf_counter() - started) * 1000

    result = results[0]
    detections = []
    if result.boxes is not None:
        for box in result.boxes:
            cls_id = int(box.cls.item())
            detections.append(
                {
                    "class_id": cls_id,
                    "class_name": result.names.get(cls_id, str(cls_id)),
                    "confidence": round(float(box.conf.item()), 4),
                    "box_xyxy": [round(float(v), 2) for v in box.xyxy[0].tolist()],
                }
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    plotted = result.plot()
    if not cv2.imwrite(str(output_path), plotted):
        raise RuntimeError(f"failed to write annotated image: {output_path}")

    print(
        json.dumps(
            {
                "model_path": str(model_path),
                "device": device,
                "inference_ms": round(inference_ms, 2),
                "detections": detections,
                "annotated_path": str(output_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
