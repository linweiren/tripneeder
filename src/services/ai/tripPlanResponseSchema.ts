const stopSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'name', 'type', 'description', 'address', 'duration'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: {
      type: 'string',
      enum: ['main_activity', 'food', 'ending_or_transition'],
    },
    description: { type: 'string' },
    address: { type: 'string' },
    duration: { type: 'number' },
    googleMapsUrl: { type: 'string' },
  },
}

const transportSegmentSchema = {
  type: 'object',
  additionalProperties: true,
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

export const tripPlanResponseSchema = {
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
        additionalProperties: true,
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
            maxItems: 6,
            items: stopSchema,
          },
          transportSegments: {
            type: 'array',
            items: transportSegmentSchema,
          },
          rainBackup: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: stopSchema,
          },
          rainTransportSegments: {
            type: 'array',
            items: transportSegmentSchema,
          },
        },
      },
    },
  },
}
