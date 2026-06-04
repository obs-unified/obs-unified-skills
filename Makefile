SKILLS := instrument-obs-unified investigate-obs-unified

.PHONY: build validate lint clean messaging-check

build:
	@mkdir -p dist
	@for skill in $(SKILLS); do \
		scripts/package.sh $$skill; \
	done

validate: messaging-check
	@for skill in $(SKILLS); do \
		scripts/validate.sh $$skill; \
	done

# RFC 0012 messaging parity: SKILL.md files vs vendored messaging.manifest.json
messaging-check:
	node scripts/messaging-check.mjs

lint:
	shellcheck scripts/*.sh

clean:
	@rm -rf dist
