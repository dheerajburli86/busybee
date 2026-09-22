FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy scheduler code
COPY . .

# Log lines reach Railway straight away. (Set after the install step so the
# cached dependency layer, and the library versions in it, are reused.)
ENV PYTHONUNBUFFERED=1

# Run the scheduler
CMD ["python", "main.py"]
