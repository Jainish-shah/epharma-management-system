"""Locust load test — concurrent-user simulation against the E-Pharma API.

Run it with `bash loadtest-locust.sh`, which starts a throwaway server and drives the scenarios
below. To drive it by hand:

    .venv/bin/locust -f locustfile.py --host http://127.0.0.1:3997          # web UI on :8089
    .venv/bin/locust -f locustfile.py --host http://127.0.0.1:3997 \
        --headless -u 100 -r 20 -t 60s                                      # headless

User classes (pick with --class-picker, or `-u` spreads across all of them by weight):

    AnonymousBrowser  the hot read path — catalog and doctor search, no session
    PatientUser       signs in, browses, checks out (the expensive write path)
    PharmacyUser      signs in, works the inventory and order queue
    SaturationUser    no think time — finds the throughput ceiling, and exercises the 429 path

The first three carry a `wait_time`, so a run of N of them measures how the service behaves under N
realistic users, not how fast it can possibly go. Use SaturationUser for the ceiling.

A 429 is recorded as its own outcome rather than a failure: being throttled is the service working
as designed, and lumping it in with real errors hides both.
"""
import random

from locust import HttpUser, between, events, task

DEMO = {
    "patient": ("priya@gmail.com", "patient123"),
    "pharmacy": ("store@medplus.com", "pharma123"),
}

# Counted separately from failures so a run can be read at a glance.
THROTTLED = {"count": 0}


@events.quitting.add_listener
def _report_throttling(environment, **_):
    if THROTTLED["count"]:
        print(f"\n  throttled (429): {THROTTLED['count']} request(s) — rate limiting was active\n")


class BaseUser(HttpUser):
    """Shared plumbing: JSON calls that treat 429 as an expected outcome, not an error."""
    abstract = True
    token = None

    def call(self, method, path, name=None, **kw):
        with self.client.request(method, path, name=name or path, catch_response=True,
                                 headers=self.headers(), **kw) as r:
            if r.status_code == 429:
                THROTTLED["count"] += 1
                r.success()          # the server refusing excess load is correct behaviour
            elif r.status_code >= 400:
                r.failure(f"{r.status_code}: {r.text[:120]}")
            return r

    def headers(self):
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def login(self, role):
        email, password = DEMO[role]
        r = self.call("POST", "/api/login", name="/api/login",
                      json={"email": email, "password": password})
        if r.status_code == 200:
            self.token = r.json().get("token")


class AnonymousBrowser(BaseUser):
    """The hot read path: the public catalog, hit by everyone who lands on the site."""
    weight = 5
    wait_time = between(0.2, 1.0)

    @task(5)
    def catalog(self):
        self.call("GET", "/api/medicines", name="/api/medicines")

    @task(3)
    def search(self):
        term = random.choice(["para", "amox", "vitamin", "cetiri", "insulin"])
        self.call("GET", f"/api/medicines?search={term}", name="/api/medicines?search=")

    @task(2)
    def doctors(self):
        self.call("GET", "/api/doctors", name="/api/doctors")

    @task(1)
    def health(self):
        self.call("GET", "/api/health", name="/api/health")


class PatientUser(BaseUser):
    """A signed-in patient: reads, then the full paid-checkout write path."""
    weight = 3
    wait_time = between(0.5, 2.0)

    def on_start(self):
        self.login("patient")

    @task(4)
    def browse(self):
        self.call("GET", "/api/medicines", name="/api/medicines")

    @task(3)
    def my_orders(self):
        self.call("GET", "/api/orders", name="/api/orders")

    @task(2)
    def notifications(self):
        self.call("GET", "/api/notifications", name="/api/notifications")

    @task(1)
    def checkout(self):
        """The heaviest path in the app: payment verification, a stock-decrementing transaction,
        invoice numbering under a row lock, and event publication — all in one request."""
        if not self.token:
            return
        items = [{"medicine_id": random.randint(1, 12), "qty": 1}]
        r = self.call("POST", "/api/payments/create", name="/api/payments/create", json={"items": items})
        if r.status_code != 200:
            return
        self.call("POST", "/api/orders", name="/api/orders (checkout)", json={
            "items": items, "type": "pickup", "payment": r.json().get("demoCheckout"),
        })


class PharmacyUser(BaseUser):
    """A signed-in pharmacy working its queue."""
    weight = 2
    wait_time = between(0.5, 2.0)

    def on_start(self):
        self.login("pharmacy")

    @task(3)
    def inventory(self):
        self.call("GET", "/api/my-medicines", name="/api/my-medicines")

    @task(3)
    def orders(self):
        self.call("GET", "/api/orders", name="/api/orders")

    @task(1)
    def stock_ledger(self):
        self.call("GET", f"/api/medicines/{random.randint(1, 12)}/stock", name="/api/medicines/:id/stock")


class SaturationUser(BaseUser):
    """No think time — every user requests as fast as the server answers.

    Used for the two questions the paced classes above cannot answer:
      * with rate limiting off, where does throughput stop scaling (the real ceiling)?
      * with it on, does the service shed the excess as 429 instead of degrading?

    Select it explicitly by name: `locust -f locustfile.py ... SaturationUser`. Do NOT leave it in
    a mixed run — with no think time it dominates the load and turns any scenario into a saturation
    test. (Locust rejects `weight = 0`, so exclusion has to be done by naming the classes you want.)
    """
    weight = 1
    wait_time = between(0, 0)

    @task
    def hammer(self):
        self.call("GET", "/api/medicines", name="/api/medicines (saturate)")
