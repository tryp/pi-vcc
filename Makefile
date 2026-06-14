# pi-vcc extension — copy-based deployment
#
# Usage:
#   make deploy      # copy fork files to runtime npm location
#   make verify      # check deployed files match source

RUNTIME = $(HOME)/.pi/agent/npm/node_modules/@sting8k/pi-vcc
SOURCE = $(HOME)/src/pi-vcc

# Files needed at runtime (extension loads from index.ts via tsgo)
DEPLOY_DIRS = \
	src \
	scripts \
	tests

DEPLOY_FILES = \
	index.ts \
	package.json \
	README.md \
	tsconfig.json

.PHONY: deploy verify link-packages test test-all

link-packages:
	@mkdir -p node_modules
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"

TSX = /home/dev/src/pi-mono/node_modules/.bin/tsx

test: link-packages  ## Run interface tests
	$(TSX) --test tests/interface.test.ts

test-all: test  ## Run all tests (add unit tests here)

deploy: ## Copy fork files to runtime npm location
	@echo "Deploying pi-vcc to $(RUNTIME)..."
	cp "$(SOURCE)/index.ts" "$(RUNTIME)/index.ts"
	cp "$(SOURCE)/package.json" "$(RUNTIME)/package.json"
	cp "$(SOURCE)/tsconfig.json" "$(RUNTIME)/tsconfig.json" 2>/dev/null || true
	cp "$(SOURCE)/README.md" "$(RUNTIME)/README.md" 2>/dev/null || true
	rm -rf "$(RUNTIME)/src" "$(RUNTIME)/scripts" "$(RUNTIME)/tests"
	cp -a "$(SOURCE)/src" "$(RUNTIME)/src"
	[ -d "$(SOURCE)/scripts" ] && cp -a "$(SOURCE)/scripts" "$(RUNTIME)/scripts"
	[ -d "$(SOURCE)/tests" ] && cp -a "$(SOURCE)/tests" "$(RUNTIME)/tests"
	@echo "Done. Verify with 'make verify'"

verify: ## Check deployed files match source
	@echo "Verifying pi-vcc deploy..."
	@diff -q "$(SOURCE)/index.ts" "$(RUNTIME)/index.ts" && \
	  echo "  index.ts: OK" || echo "  index.ts: MISMATCH"
	@diff -q "$(SOURCE)/src/tools/recall.ts" "$(RUNTIME)/src/tools/recall.ts" && \
	  echo "  src/tools/recall.ts: OK" || echo "  src/tools/recall.ts: MISMATCH"
	@echo "Verify complete"
