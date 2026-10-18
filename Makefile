VERSION ?= dev
GO ?= go

.PHONY: build test check fmt schema release docker-test docker-smoke clean
build:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/kiln ./cmd/kiln

test:
	$(GO) test -race -count=1 -timeout 90s ./...

check:
	test -z "$$(gofmt -l cmd internal)"
	$(GO) vet ./...
	$(GO) test -race -count=1 -timeout 90s ./...
	$(MAKE) build
	./bin/kiln validate examples/retry.yaml
	./bin/kiln validate examples/multi-provider.yaml
	./bin/kiln validate examples/scoped-agent.yaml
	./bin/kiln validate examples/sandbox.yaml

fmt:
	gofmt -w cmd internal

schema: build
	./bin/kiln openapi > docs/openapi.json

release:
	mkdir -p bin
	set -eu; for target in linux/amd64 linux/arm64 darwin/arm64; do \
		GOOS=$${target%/*} GOARCH=$${target#*/} CGO_ENABLED=0 $(GO) build -trimpath \
			-ldflags "-s -w -X main.version=$(VERSION)" -o bin/kiln-$${target%/*}-$${target#*/} ./cmd/kiln; \
	done
	cd bin && shasum -a 256 kiln-linux-amd64 kiln-linux-arm64 kiln-darwin-arm64 > SHA256SUMS

docker-test:
	docker build --target test -t kiln-test .

docker-smoke:
	docker build -t kiln:0.1.0 .
	python3 scripts/container_smoke.py

clean:
	rm -rf bin coverage.out
