# Dockerfile
FROM nginx:alpine

# Remove default content
RUN rm -rf /usr/share/nginx/html/*

# Copy the frontend files (only needed if you want a static build)
COPY ./frontend /usr/share/nginx/html

# Expose port 80
EXPOSE 80
