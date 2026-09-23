FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static
RUN useradd --create-home tmrw && mkdir /data && chown tmrw:tmrw /data
USER tmrw
ENV DATABASE_PATH=/data/tmrw.sqlite3 COOKIE_SECURE=1
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "2", "app:app"]
