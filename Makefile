SKILLS := instrument-obs-unified investigate-obs-unified

.PHONY: build validate lint clean

build:
	@mkdir -p dist
	@for skill in $(SKILLS); do \
		scripts/package.sh $$skill; \
	done

validate:
	@for skill in $(SKILLS); do \
		scripts/validate.sh $$skill; \
	done

lint:
	shellcheck scripts/*.sh

clean:
	@rm -rf dist
