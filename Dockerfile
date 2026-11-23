FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
    PUBLIC_MODE=true FRONTEND_DIST_PATH=/app/frontend/dist \
    DATABASE_PATH=/data/simtrm.sqlite3 AUTO_SYNC_ENABLED=true
WORKDIR /app/backend
COPY backend/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock \
    && useradd --uid 10001 --create-home simtrm
COPY backend/app/ ./app/
COPY backend/manage.py ./
COPY scripts/start-production.py /app/scripts/start-production.py
COPY --from=frontend /build/frontend/dist/ /app/frontend/dist/
EXPOSE 8080
# The launcher fixes the mounted volume's owner and drops root before starting Uvicorn.
CMD ["python", "/app/scripts/start-production.py"]
