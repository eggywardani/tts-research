# OmniVoice + RVC TTS service — needs a CUDA GPU at runtime.
# CUDA 12.8 so it supports Blackwell (RTX 50xx, sm_120).
# Plain `-runtime` (not `-cudnn-runtime`): the torch cu128 wheels bundle their own
# cuDNN/cuBLAS/etc., so the base's cuDNN would just be dead weight (~1.5 GB).
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch + torchaudio together from the CUDA 12.8 wheel index (Blackwell/sm_120).
# They MUST come from the same index — installing torchaudio separately (e.g. as
# an omnivoice dependency from PyPI) pulls an ABI-mismatched build and fails with
# "Could not load this library: .../_torchaudio.abi3.so".
RUN pip3 install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu128

# Install omnivoice etc. WITHOUT letting pip swap out the CUDA torch/torchaudio
# above — the constraints file pins them to whatever we just installed.
COPY requirements.txt .
RUN pip3 freeze | grep -E '^(torch|torchaudio)==' > /tmp/torch-constraints.txt && \
    pip3 install --no-cache-dir -c /tmp/torch-constraints.txt -r requirements.txt

COPY . .

ENV PORT=9000
EXPOSE 9000
CMD ["python3", "main.py"]
