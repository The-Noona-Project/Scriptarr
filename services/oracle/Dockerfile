ARG LOCALAI_IMAGE=localai/localai:v4.1.3-gpu-nvidia-cuda-12

FROM ${LOCALAI_IMAGE} AS localai_runtime

FROM localai_runtime AS localai_assets

RUN set -eux; \
    mkdir -p \
        /scriptarr-localai-bin/usr/local/bin \
        /scriptarr-cuda-cudart/usr/local/cuda-12.8/targets/x86_64-linux/lib \
        /scriptarr-cuda-cublas/usr/local/cuda-12.8/targets/x86_64-linux/lib \
        /scriptarr-cuda-cublaslt/usr/local/cuda-12.8/targets/x86_64-linux/lib; \
    if [ -x /local-ai ]; then \
        cp /local-ai /scriptarr-localai-bin/usr/local/bin/local-ai; \
    elif [ -x /build/local-ai ]; then \
        cp /build/local-ai /scriptarr-localai-bin/usr/local/bin/local-ai; \
    elif command -v local-ai >/dev/null 2>&1; then \
        cp "$(command -v local-ai)" /scriptarr-localai-bin/usr/local/bin/local-ai; \
    else \
        echo "Unable to locate local-ai binary in ${LOCALAI_IMAGE}" >&2; \
        exit 1; \
    fi; \
    chmod +x /scriptarr-localai-bin/usr/local/bin/local-ai; \
    if [ -d /usr/local/cuda-12.8/targets/x86_64-linux/lib ]; then \
        cp -a /usr/local/cuda-12.8/targets/x86_64-linux/lib/libcudart.so* /scriptarr-cuda-cudart/usr/local/cuda-12.8/targets/x86_64-linux/lib/; \
        cp -a /usr/local/cuda-12.8/targets/x86_64-linux/lib/libcublas.so* /scriptarr-cuda-cublas/usr/local/cuda-12.8/targets/x86_64-linux/lib/; \
        cp -a /usr/local/cuda-12.8/targets/x86_64-linux/lib/libcublasLt.so* /scriptarr-cuda-cublaslt/usr/local/cuda-12.8/targets/x86_64-linux/lib/; \
    fi

FROM python:3.12-slim

COPY --from=localai_assets /scriptarr-localai-bin/ /
COPY --from=localai_assets /scriptarr-cuda-cudart/ /
COPY --from=localai_assets /scriptarr-cuda-cublas/ /
COPY --from=localai_assets /scriptarr-cuda-cublaslt/ /

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV SCRIPTARR_LOCALAI_EMBEDDED=1
ENV SCRIPTARR_LOCALAI_BIN=/usr/local/bin/local-ai
ENV SCRIPTARR_LOCALAI_ARGS="run --address 127.0.0.1:8080 --models-path /models --backends-path /data/backends --disable-web-ui"
ENV SCRIPTARR_LOCALAI_MODELS_DIR=/models
ENV SCRIPTARR_LOCALAI_DATA_DIR=/data
ENV SCRIPTARR_LOCALAI_BACKENDS_PATH=/data/backends
ENV SCRIPTARR_LOCALAI_TMP_DIR=/data/tmp
ENV SCRIPTARR_LOCALAI_BACKEND=llama-cpp
ENV SCRIPTARR_LOCALAI_CONTEXT_SIZE=4096
ENV SCRIPTARR_LOCALAI_GPU_LAYERS=auto
ENV SCRIPTARR_LOCALAI_DEFAULT_MODEL=huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_S.gguf
ENV SCRIPTARR_LOCALAI_ALTERNATE_MODELS=huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_M.gguf,huggingface://Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf
ENV LOCALAI_MODELS_PATH=/models
ENV MODELS_PATH=/models
ENV LOCALAI_DATA_PATH=/data
ENV LOCALAI_BACKENDS_PATH=/data/backends
ENV BACKENDS_PATH=/data/backends
ENV LOCALAI_BACKENDS_SYSTEM_PATH=/data/backends
ENV BACKEND_SYSTEM_PATH=/data/backends
ENV LOCALAI_BACKEND_ASSETS_PATH=/data/backend_data
ENV BACKEND_ASSETS_PATH=/data/backend_data
ENV LOCALAI_GENERATED_CONTENT_PATH=/data/generated
ENV LOCALAI_UPLOAD_PATH=/data/upload
ENV LOCALAI_CONFIG_PATH=/models
ENV CONFIG_PATH=/models
ENV TMPDIR=/data/tmp
ENV TMP=/data/tmp
ENV TEMP=/data/tmp
ENV CUDA_HOME=/usr/local/cuda-12.8
ENV LD_LIBRARY_PATH=/usr/local/cuda-12.8/targets/x86_64-linux/lib:/usr/local/cuda/lib64:/usr/local/cuda-12.8/lib64:/usr/local/cuda-12/lib64

WORKDIR /app

COPY services/oracle/requirements.txt ./requirements.txt

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libgomp1 && \
    rm -rf /var/lib/apt/lists/* && \
    if [ -d /usr/local/cuda-12.8 ]; then \
        ln -sfn cuda-12.8 /usr/local/cuda; \
        ln -sfn targets/x86_64-linux/lib /usr/local/cuda-12.8/lib64; \
    fi && \
    mkdir -p /models /data/backends /data/backend_data /data/generated /data/upload /data/tmp && \
    chmod +x /usr/local/bin/local-ai && \
    python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY services/oracle ./

EXPOSE 3001

CMD ["python", "server.py"]
