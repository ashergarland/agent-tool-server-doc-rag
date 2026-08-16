targetScope = 'subscription'

@description('Short environment suffix such as dev, test, or prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Azure region for all resources.')
param location string = deployment().location

@description('Immutable container image reference used on the second pass.')
param containerImage string = 'replace.invalid/agent-tool-server:replace-me'

@description('False for the prerequisite pass; true only after the Key Vault secret and image exist.')
param deployApp bool = false

@description('Existing Key Vault secret name used by the application.')
param apiKeySecretName string = 'tool-server-api-key'

@description('Object ID allowed to seed the Key Vault secret during bootstrap; leave blank outside bootstrap.')
param bootstrapPrincipalObjectId string = ''

@description('Corpus mode. A hosted app deployed with "none" stays not-ready by design.')
@allowed([
  'none'
  'filesystem'
  'azure-blob'
])
param corpusSource string = 'azure-blob'

@description('Read-only mount path used when corpusSource is filesystem.')
param docsRoot string = '/corpus'

@description('Managed environment storage name for a read-only corpus file share.')
param corpusFileShareStorageName string = ''

@description('Private container that holds the corpus when corpusSource is azure-blob.')
param storageContainerName string = 'corpus'

@description('Optional corpus prefix inside the container.')
param storagePrefix string = ''

@description('Bounded refresh interval in milliseconds. Zero disables background refresh.')
@minValue(0)
param corpusRefreshIntervalMs int = 300000

@description('Maximum documents admitted into one index.')
@minValue(1)
param corpusMaxDocuments int = 2000

@description('Maximum bytes read from a single document.')
@minValue(1024)
param corpusMaxDocumentBytes int = 1048576

@description('Maximum total bytes read into one index.')
@minValue(1024)
param corpusMaxTotalBytes int = 33554432

@description('Maximum chunks retained in one index.')
@minValue(1)
param indexMaxChunks int = 20000

@description('Index build deadline in milliseconds.')
@minValue(1000)
param indexBuildTimeoutMs int = 60000

@description('Concurrent searches served before queueing.')
@minValue(1)
param searchMaxConcurrent int = 4

@description('Queued searches accepted before callers are rate limited.')
@minValue(0)
param searchQueueLimit int = 32

@description('Search deadline in milliseconds.')
@minValue(50)
param searchTimeoutMs int = 2000

param containerCpu string = '0.25'
param containerMemory string = '0.5Gi'

@description('Concurrent requests per replica used by the HTTP scale rule.')
@minValue(1)
param concurrentRequests int = 20

@description('Minimum replicas. Use 1 for predictable readiness; 0 rebuilds the index on each cold start.')
@minValue(0)
param minReplicas int = 1

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Action group resource ID that receives failure alerts. Empty disables alerts.')
param alertActionGroupId string = ''

@description('Additional resource tags applied to every resource.')
param additionalTags object = {}

var suffix = uniqueString(subscription().id, environmentName)
var resourceGroupName = 'rg-ats-${environmentName}-${suffix}'
var baseTags = union(
  {
    application: 'agent-tool-server'
    component: 'doc-rag'
    environment: environmentName
    corpusSource: corpusSource
    managedBy: 'bicep'
  },
  additionalTags
)
var deployCorpusStorage = corpusSource == 'azure-blob'
var storageAccountName = 'stats${suffix}'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: baseTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: resourceGroup
  params: {
    location: location
    name: 'id-ats-${environmentName}-${suffix}'
    tags: baseTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: resourceGroup
  params: {
    location: location
    name: 'crats${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: baseTags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: resourceGroup
  params: {
    location: location
    name: 'kv-ats-${suffix}'
    accessPrincipalObjectId: identity.outputs.principalId
    bootstrapPrincipalObjectId: bootstrapPrincipalObjectId
    tags: baseTags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: 'log-ats-${environmentName}-${suffix}'
    insightsName: 'appi-ats-${environmentName}-${suffix}'
    tags: baseTags
  }
}

module corpusStorage 'modules/storage.bicep' = if (deployCorpusStorage) {
  name: 'corpus-storage'
  scope: resourceGroup
  params: {
    location: location
    name: storageAccountName
    containerName: storageContainerName
    readerPrincipalId: identity.outputs.principalId
    tags: baseTags
  }
}

module app 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: resourceGroup
  params: {
    location: location
    environmentName: 'cae-ats-${environmentName}-${suffix}'
    appName: 'ca-ats-${environmentName}-${suffix}'
    containerImage: containerImage
    registryServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    apiKeySecretUri: '${keyVault.outputs.vaultUri}secrets/${apiKeySecretName}'
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: observability.outputs.workspaceSharedKey
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    corpusSource: corpusSource
    docsRoot: docsRoot
    corpusFileShareStorageName: corpusFileShareStorageName
    storageAccountName: deployCorpusStorage ? corpusStorage!.outputs.accountName : ''
    storageContainerName: deployCorpusStorage ? corpusStorage!.outputs.containerName : ''
    storagePrefix: storagePrefix
    corpusRefreshIntervalMs: corpusRefreshIntervalMs
    corpusMaxDocuments: corpusMaxDocuments
    corpusMaxDocumentBytes: corpusMaxDocumentBytes
    corpusMaxTotalBytes: corpusMaxTotalBytes
    indexMaxChunks: indexMaxChunks
    indexBuildTimeoutMs: indexBuildTimeoutMs
    searchMaxConcurrent: searchMaxConcurrent
    searchQueueLimit: searchQueueLimit
    searchTimeoutMs: searchTimeoutMs
    cpu: containerCpu
    memory: containerMemory
    concurrentRequests: concurrentRequests
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    alertActionGroupId: alertActionGroupId
    tags: baseTags
  }
}

output resourceGroupName string = resourceGroupName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output managedIdentityClientId string = identity.outputs.clientId
output corpusStorageAccountName string = deployCorpusStorage ? corpusStorage!.outputs.accountName : ''
output corpusContainerName string = deployCorpusStorage ? corpusStorage!.outputs.containerName : ''
output applicationUrl string = deployApp ? 'https://${app!.outputs.fqdn}' : ''
