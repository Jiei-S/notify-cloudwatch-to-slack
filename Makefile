.PHONY: dev
dev:
	docker compose down || true
	docker compose up --build