from .main import build_rag_index

result = build_rag_index()
print(f"Indexed {result['sourceCount']} PDFs into {result['chunkCount']} chunks.")
print(f"Chunks: {result['chunksFile']}")
print(f"Vectors: {result['vectorFile']}")
