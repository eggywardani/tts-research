# OmniVoice + RVC TTS service — needs a CUDA GPU at runtime.
# CUDA 12.8 so it supports Blackwell (RTX 50xx, sm_120).
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch first, pinned to the CUDA 12.8 wheel index (Blackwell/sm_120 support).
RUN pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=9001
EXPOSE 9001
CMD ["python3", "main.py"]
