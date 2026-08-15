param location string
param environmentName string
param appName string
param containerImage string
param registryServer string
param identityId string
param apiKeySecretUri string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
@secure()
param applicationInsightsConnectionString string

@description('Corpus mode. A hosted app with "none" stays not-ready by design.')
@allowed([
  'none'
  'filesystem'
  'azure-blob'
])
param corpusSource string

@description('Read-only mount path used when corpusSource is filesystem.')
param docsRoot string = '/corpus'

@description('Managed environment storage name for the read-only corpus file share.')
param corpusFileShareStorageName string = ''

@description('Storage account holding the corpus when corpusSource is azure-blob.')
param storageAccountName string = ''

@description('Private container holding the corpus when corpusSource is azure-blob.')
param storageContainerName string = ''

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

param cpu string = '0.25'
param memory string = '0.5Gi'
param minReplicas int
param maxReplicas int

@description('Concurrent requests per replica used by the HTTP scale rule.')
@minValue(1)
param concurrentRequests int = 20

@description('Action group resource ID that receives readiness and failure alerts. Empty disables alerts.')
param alertActionGroupId string = ''

param tags object

var mountCorpusShare = corpusSource == 'filesystem' && !empty(corpusFileShareStorageName)

var corpusEnvironment = concat(
  [
    {
      name: 'CORPUS_SOURCE'
      value: corpusSource
    }
    {
      name: 'CORPUS_REFRESH_INTERVAL_MS'
      value: string(corpusRefreshIntervalMs)
    }
    {
      name: 'CORPUS_MAX_DOCUMENTS'
      value: string(corpusMaxDocuments)
    }
    {
      name: 'CORPUS_MAX_DOCUMENT_BYTES'
      value: string(corpusMaxDocumentBytes)
    }
    {
      name: 'CORPUS_MAX_TOTAL_BYTES'
      value: string(corpusMaxTotalBytes)
    }
    {
      name: 'INDEX_MAX_CHUNKS'
      value: string(indexMaxChunks)
    }
    {
      name: 'INDEX_BUILD_TIMEOUT_MS'
      value: string(indexBuildTimeoutMs)
    }
    {
      name: 'SEARCH_MAX_CONCURRENT'
      value: string(searchMaxConcurrent)
    }
    {
      name: 'SEARCH_QUEUE_LIMIT'
      value: string(searchQueueLimit)
    }
    {
      name: 'SEARCH_TIMEOUT_MS'
      value: string(searchTimeoutMs)
    }
  ],
  corpusSource == 'filesystem'
    ? [
        {
          name: 'DOCS_ROOT'
          value: docsRoot
        }
      ]
    : [],
  corpusSource == 'azure-blob'
    ? [
        {
          name: 'AZURE_STORAGE_ACCOUNT_NAME'
          value: storageAccountName
        }
        {
          name: 'AZURE_STORAGE_CONTAINER'
          value: storageContainerName
        }
        {
          name: 'AZURE_STORAGE_PREFIX'
          value: storagePrefix
        }
      ]
    : []
)

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'tool-server'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(
            [
              {
                name: 'NODE_ENV'
                value: 'production'
              }
              {
                name: 'AUTH_MODE'
                value: 'api-key'
              }
              {
                name: 'API_KEYS'
                secretRef: 'api-key'
              }
              {
                name: 'AZURE_CLIENT_ID'
                value: reference(identityId, '2023-01-31').clientId
              }
              {
                name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
                value: applicationInsightsConnectionString
              }
            ],
            corpusEnvironment
          )
          volumeMounts: mountCorpusShare
            ? [
                {
                  volumeName: 'corpus'
                  mountPath: docsRoot
                }
              ]
            : []
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              // Readiness requires a usable configured index, so cold indexing keeps traffic away.
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 30
            }
          ]
        }
      ]
      volumes: mountCorpusShare
        ? [
            {
              name: 'corpus'
              storageType: 'AzureFile'
              storageName: corpusFileShareStorageName
            }
          ]
        : []
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(concurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

resource failureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(alertActionGroupId)) {
  name: '${appName}-failed-requests'
  location: 'global'
  tags: tags
  properties: {
    description: 'Server-side failures indicate an unusable index or a failing corpus.'
    severity: 2
    enabled: true
    scopes: [
      app.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrors'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: [
                '5xx'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: alertActionGroupId
      }
    ]
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
