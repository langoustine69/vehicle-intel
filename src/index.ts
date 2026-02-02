import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync } from 'fs';

const agent = await createAgent({
  name: 'vehicle-intel',
  version: '1.0.0',
  description: 'Vehicle Intelligence from NHTSA - VIN decoding, safety recalls, makes/models lookup. Official US government vehicle data for AI agents.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

const NHTSA_VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const NHTSA_RECALLS = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
const NHTSA_COMPLAINTS = 'https://api.nhtsa.gov/complaints/complaintsByVehicle';

async function fetchJSON(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NHTSA API error: ${response.status}`);
  }
  return response.json();
}

function cleanVinResults(results: any[]): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const item of results) {
    if (item.Value && item.Value !== '' && item.Value !== 'Not Applicable') {
      cleaned[item.Variable] = item.Value;
    }
  }
  return cleaned;
}

// === FREE: Vehicle Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of vehicle database - available makes and API capabilities',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const makes = await fetchJSON(`${NHTSA_VPIC}/GetAllMakes?format=json`);
    const popularMakes = ['Toyota', 'Ford', 'Honda', 'Chevrolet', 'Tesla', 'BMW', 'Mercedes-Benz', 'Audi', 'Volkswagen', 'Nissan'];
    
    return {
      output: {
        totalMakes: makes.Results?.length || 0,
        popularMakes,
        capabilities: [
          'VIN decoding - Get full vehicle specs from any 17-digit VIN',
          'Safety recalls - Check open recalls by VIN or make/model/year',
          'Complaints - View consumer complaints by make/model/year',
          'Makes catalog - All vehicle manufacturers',
          'Models lookup - Models by make',
        ],
        dataSource: 'NHTSA (National Highway Traffic Safety Administration)',
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID 1: VIN Decode ($0.001) ===
addEntrypoint({
  key: 'decode-vin',
  description: 'Decode a VIN to get full vehicle specifications - make, model, year, engine, body type, and more',
  input: z.object({
    vin: z.string().length(17).describe('17-character Vehicle Identification Number'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const vin = ctx.input.vin.toUpperCase();
    const data = await fetchJSON(`${NHTSA_VPIC}/decodevin/${vin}?format=json`);
    const specs = cleanVinResults(data.Results);
    
    return {
      output: {
        vin,
        isValid: specs['Error Code'] === '0',
        errorMessage: specs['Error Text'],
        vehicle: {
          make: specs['Make'],
          model: specs['Model'],
          year: specs['Model Year'],
          trim: specs['Trim'],
          bodyClass: specs['Body Class'],
          vehicleType: specs['Vehicle Type'],
          doors: specs['Doors'],
        },
        engine: {
          displacement: specs['Displacement (L)'],
          cylinders: specs['Engine Number of Cylinders'],
          fuelType: specs['Fuel Type - Primary'],
          horsepower: specs['Engine Brake (hp) From'],
        },
        manufacturer: {
          name: specs['Manufacturer Name'],
          plantCity: specs['Plant City'],
          plantCountry: specs['Plant Country'],
        },
        safety: {
          airbags: specs['Air Bag Loc Front'],
          abs: specs['Brake System Type'],
        },
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID 2: Recalls by VIN ($0.002) ===
addEntrypoint({
  key: 'recalls-by-vin',
  description: 'Check safety recalls for a specific VIN - decodes VIN and looks up recalls by make/model/year',
  input: z.object({
    vin: z.string().length(17).describe('17-character VIN to check for recalls'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const vin = ctx.input.vin.toUpperCase();
    
    // First decode VIN to get make/model/year
    const decoded = await fetchJSON(`${NHTSA_VPIC}/decodevin/${vin}?format=json`);
    const specs = cleanVinResults(decoded.Results);
    
    if (!specs['Make'] || !specs['Model'] || !specs['Model Year']) {
      return {
        output: {
          vin,
          error: 'Could not decode VIN to get vehicle details',
          vehicle: null,
          recallCount: 0,
          recalls: [],
        }
      };
    }
    
    // Look up recalls by make/model/year (use lowercase for better compatibility)
    const make = specs['Make'].toLowerCase();
    const model = specs['Model'].toLowerCase();
    const year = specs['Model Year'];
    
    const recallUrl = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
    const recallResponse = await fetch(recallUrl);
    
    let recalls: any[] = [];
    if (recallResponse.ok) {
      const recallData = await recallResponse.json();
      recalls = recallData.results || [];
    }
    
    return {
      output: {
        vin,
        vehicle: `${specs['Model Year']} ${specs['Make']} ${specs['Model']}`,
        recallCount: recalls.length,
        recalls: recalls.slice(0, 20).map((r: any) => ({
          campaignNumber: r.NHTSACampaignNumber,
          component: r.Component,
          summary: r.Summary,
          consequence: r.Consequence,
          remedy: r.Remedy,
          manufacturer: r.Manufacturer,
        })),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID 3: Models by Make ($0.002) ===
addEntrypoint({
  key: 'models',
  description: 'Get all models for a vehicle make',
  input: z.object({
    make: z.string().describe('Vehicle manufacturer name (e.g., Toyota, Tesla, Ford)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const make = ctx.input.make;
    const data = await fetchJSON(`${NHTSA_VPIC}/GetModelsForMake/${encodeURIComponent(make)}?format=json`);
    
    const models = data.Results?.map((r: any) => ({
      make: r.Make_Name,
      model: r.Model_Name,
    })) || [];
    
    return {
      output: {
        make,
        modelCount: models.length,
        models: models.map((m: any) => m.model),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID 4: Complaints by Vehicle ($0.003) ===
addEntrypoint({
  key: 'complaints',
  description: 'Get consumer complaints for a specific vehicle make/model/year',
  input: z.object({
    make: z.string().describe('Vehicle make (e.g., Toyota)'),
    model: z.string().describe('Vehicle model (e.g., Camry)'),
    year: z.number().describe('Model year (e.g., 2020)'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const { make, model, year } = ctx.input;
    const data = await fetchJSON(
      `${NHTSA_COMPLAINTS}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`
    );
    
    const complaints = data.results || [];
    
    return {
      output: {
        vehicle: `${year} ${make} ${model}`,
        complaintCount: complaints.length,
        complaints: complaints.slice(0, 20).map((c: any) => ({
          id: c.odiNumber,
          component: c.components,
          summary: c.summary?.substring(0, 500),
          crash: c.crash,
          fire: c.fire,
          injuries: c.injuries,
          dateReceived: c.dateOfIncident,
        })),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID 5: Compare Vehicles ($0.005) ===
addEntrypoint({
  key: 'compare',
  description: 'Compare multiple VINs side by side - specs, recalls, complaints',
  input: z.object({
    vins: z.array(z.string().length(17)).min(2).max(5).describe('2-5 VINs to compare'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const results = await Promise.all(
      ctx.input.vins.map(async (vin) => {
        const v = vin.toUpperCase();
        const decoded = await fetchJSON(`${NHTSA_VPIC}/decodevin/${v}?format=json`);
        const specs = cleanVinResults(decoded.Results);
        
        let recallCount = 0;
        try {
          const recalls = await fetchJSON(`${NHTSA_RECALLS}?vin=${v}`);
          recallCount = recalls.results?.length || 0;
        } catch {}
        
        return {
          vin: v,
          year: specs['Model Year'],
          make: specs['Make'],
          model: specs['Model'],
          trim: specs['Trim'],
          bodyClass: specs['Body Class'],
          engine: `${specs['Displacement (L)']}L ${specs['Engine Number of Cylinders']}-cyl`,
          fuelType: specs['Fuel Type - Primary'],
          manufacturer: specs['Manufacturer Name'],
          plantCountry: specs['Plant Country'],
          recallCount,
        };
      })
    );
    
    return {
      output: {
        comparison: results,
        comparedAt: new Date().toISOString(),
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available' } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const icon = readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// ERC-8004 registration
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://vehicle-intel-production.up.railway.app';
  
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'vehicle-intel',
    description: 'Vehicle Intelligence from NHTSA - VIN decoding, safety recalls, makes/models. Official US government vehicle data for AI agents.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Vehicle Intel agent running on port ${port}`);

export default { port, fetch: app.fetch };
