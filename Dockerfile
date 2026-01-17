FROM nginx:alpine

# Remove default nginx website
RUN rm -rf /usr/share/nginx/html/*

# Copy everything from current folder (.) into nginx
COPY . /usr/share/nginx/html/

# Expose port 80
EXPOSE 80
