using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param deployApp = false
param containerImage = 'replace.invalid/agent-tool-server:replace-me'

// Corpus boundary. One deployment serves one corpus and one audience.
param corpusSource = 'azure-blob'
param storageContainerName = 'corpus'
param storagePrefix = ''

// Bounded ingestion and retrieval. Requests can never raise these ceilings.
param corpusRefreshIntervalMs = 300000
param corpusMaxDocuments = 2000
param corpusMaxDocumentBytes = 1048576
param corpusMaxTotalBytes = 33554432
param indexMaxChunks = 20000
param indexBuildTimeoutMs = 60000
param searchMaxConcurrent = 4
param searchQueueLimit = 32
param searchTimeoutMs = 2000

// minReplicas=1 keeps readiness predictable; 0 rebuilds the index on every cold start.
param containerCpu = '0.25'
param containerMemory = '0.5Gi'
param concurrentRequests = 20
param minReplicas = 1
param maxReplicas = 3

param alertActionGroupId = ''
param additionalTags = {}
