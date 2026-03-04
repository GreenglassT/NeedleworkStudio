FROM python:3.12-slim AS builder

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim

WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/gunicorn /usr/local/bin/gunicorn
COPY app.py init_db.py anchor_threads.py manage_users.py schema.sql ./
COPY static/ static/
COPY templates/ templates/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NEEDLEWORK_DATA_DIR=/data
ENV PORT=6969
EXPOSE 6969
VOLUME /data

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["gunicorn", "-w", "1", "--threads", "4", "-b", "0.0.0.0:6969", "app:app"]
