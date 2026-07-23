# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe python-fastapi (python).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
RUN pip install uvicorn
COPY . .
EXPOSE 8000
CMD uvicorn main:app --host 0.0.0.0 --port 8000
