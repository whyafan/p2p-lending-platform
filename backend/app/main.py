# Loaded before anything else is imported: chain_fetcher reads ALCHEMY_API_KEY and
# NEXUSFI_FACTORY_SEPOLIA at module scope, so by the time the router import chain
# reaches it the environment has to already be populated.
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routers import credit

app = FastAPI(title="NexusFi Credit API", version="1.0.0")

# Wildcard origin is tolerable because no browser talks to this service: the Next
# route at /api/credit/score proxies it server to server, so this only affects
# someone poking the API from a local tool. It would need tightening if the service
# were ever exposed directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

app.include_router(credit.router)


@app.get("/health")
async def health():
    # Imported inside the handler so starting the app never pulls in lightgbm, shap
    # and the pickled model. The first caller pays that cost, not startup, and a
    # missing artifacts directory shows up as model_ready false rather than a crash.
    from .ml.model import CreditScorer
    scorer = CreditScorer.get()
    return {
        "status": "ok",
        "model_ready": scorer.ready,
    }
