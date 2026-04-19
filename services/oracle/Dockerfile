FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/oracle/requirements.txt ./requirements.txt

RUN python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY services/oracle ./

EXPOSE 3001

CMD ["python", "server.py"]
