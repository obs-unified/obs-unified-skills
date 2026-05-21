SKILLS := instrument-obs-unified investigate-obs-unified

.PHONY: build validate clean

build:
	@mkdir -p dist
	@for skill in $(SKILLS); do \
		scripts/package.sh $$skill; \
	done

validate:
	@for skill in $(SKILLS); do \
		scripts/validate.sh $$skill; \
	done

clean:
	@rm -rf dist
