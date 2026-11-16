GO ?= go

.PHONY: build test check fmt docker-test
build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w" -o bin/kiln ./cmd/kiln

test:
	$(GO) test -race -count=1 -timeout 120s ./...

check:
	test -z "$$(gofmt -l cmd internal)"
	$(GO) vet ./...
	$(MAKE) test
	$(MAKE) build

fmt:
	gofmt -w cmd internal

docker-test:
	docker build --target test -t kiln-test .
