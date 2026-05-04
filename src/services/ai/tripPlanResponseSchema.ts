const stopSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'type', 'description', 'address', 'duration', 'placeId'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    type: {
      type: 'string',
      enum: ['main_activity', 'food', 'ending_or_transition'],
    },
    description: { type: 'string' },
    address: { type: 'string', minLength: 1 },
    duration: { type: 'number' },
    placeId: { type: 'string', minLength: 1 },
  },
}

const skeletonStopSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'type', 'address', 'duration', 'placeId'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    type: {
      type: 'string',
      enum: ['main_activity', 'food', 'ending_or_transition'],
    },
    address: { type: 'string', minLength: 1 },
    duration: { type: 'number' },
    placeId: { type: 'string', minLength: 1 },
  },
}

const transportSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fromStopId', 'toStopId', 'mode', 'duration', 'label'],
  properties: {
    fromStopId: { type: 'string' },
    toStopId: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['scooter', 'car', 'public_transit'],
    },
    publicTransitType: {
      type: 'string',
      enum: ['bus', 'metro', 'train', 'walk', 'mixed'],
    },
    duration: { type: 'number' },
    label: { type: 'string' },
  },
}

const skeletonTransportSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fromStopId', 'toStopId', 'mode', 'duration'],
  properties: {
    fromStopId: { type: 'string' },
    toStopId: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['scooter', 'car', 'public_transit'],
    },
    duration: { type: 'number' },
  },
}

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'type',
    'title',
    'subtitle',
    'summary',
    'totalTime',
    'budget',
    'transportMode',
    'stops',
    'transportSegments',
    'rainBackup',
    'rainTransportSegments',
  ],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['safe', 'balanced', 'explore'] },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    summary: { type: 'string' },
    totalTime: { type: 'number' },
    budget: { type: 'number' },
    transportMode: {
      type: 'string',
      enum: ['scooter', 'car', 'public_transit'],
    },
    stops: {
      type: 'array',
      minItems: 2,
      items: stopSchema,
    },
    transportSegments: {
      type: 'array',
      items: transportSegmentSchema,
    },
    rainBackup: {
      type: 'array',
      minItems: 2,
      items: stopSchema,
    },
    rainTransportSegments: {
      type: 'array',
      items: transportSegmentSchema,
    },
  },
}

export const tripPlanResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plans'],
  properties: {
    plans: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: planSchema,
    },
  },
}

export const tripPlanSkeletonResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plans'],
  properties: {
    plans: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'type',
          'title',
          'subtitle',
          'summary',
          'totalTime',
          'budget',
          'transportMode',
          'stops',
          'transportSegments',
        ],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['safe', 'balanced', 'explore'] },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          summary: { type: 'string' },
          totalTime: { type: 'number' },
          budget: { type: 'number' },
          transportMode: {
            type: 'string',
            enum: ['scooter', 'car', 'public_transit'],
          },
          stops: {
            type: 'array',
            minItems: 2,
            items: skeletonStopSchema,
          },
          transportSegments: {
            type: 'array',
            items: skeletonTransportSegmentSchema,
          },
        },
      },
    },
  },
}

export const tripPlanDetailsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan'],
  properties: {
    plan: planSchema,
  },
}
