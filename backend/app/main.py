from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routers import credit

app = FastAPI(title="NexusFi Credit API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

app.include_router(credit.router)


@app.get("/health")
async def health():
    from .ml.model import CreditScorer
    scorer = CreditScorer.get()
    return {
        "status": "ok",
        "model_ready": scorer.ready,
    }
