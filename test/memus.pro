# HTTP → HTTPS redirect
server {
    if ($host = www.memus.pro) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    if ($host = memus.pro) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    listen [::]:80;
    server_name memus.pro www.memus.pro;
    return 301 https://$host$request_uri;




}

# Основной HTTPS reverse proxy
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name memus.pro www.memus.pro;
    ssl_certificate /etc/letsencrypt/live/memus.pro/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/memus.pro/privkey.pem; # managed by Certbot

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Вместо 503 при лимитах — возвращаем 429 (Too Many Requests).
    limit_req_status 429;
    limit_conn_status 429;

    location /api/import/logseq {
        client_max_body_size 50M;
        client_body_timeout 60s;

        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # Лимиты применяем только к API, не к статикам (иначе /sidebar/*.js может получить 503).
        limit_req zone=req_limit burst=50 nodelay;
        limit_conn conn_limit 20;

        proxy_pass http://127.0.0.1:4500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location ^~ /api/ {
        limit_req zone=req_limit burst=50 nodelay;
        limit_conn conn_limit 20;

        proxy_pass http://127.0.0.1:4500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # ВАЖНО — ЗДЕСЬ ПОДСТАВЬ СВОЙ ПОРТ PYTHON-ПРИЛОЖЕНИЯ
    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }


}
