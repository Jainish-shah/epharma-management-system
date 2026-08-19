#!/usr/bin/env python
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "epharma_site.settings")

    # `runserver` with no address uses $PORT when set (Django itself ignores PORT). This lets a
    # host assign the port, while an explicitly passed "host:port" argument still wins.
    argv = list(sys.argv)
    if len(argv) > 1 and argv[1] == "runserver" and os.environ.get("PORT"):
        if not any(not a.startswith("-") for a in argv[2:]):  # no address argument given
            argv.insert(2, f"127.0.0.1:{os.environ['PORT']}")

    from django.core.management import execute_from_command_line
    execute_from_command_line(argv)


if __name__ == "__main__":
    main()
