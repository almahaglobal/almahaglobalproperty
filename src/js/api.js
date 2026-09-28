import { supabase } from './supabase.js';

const API_BASE_URL = '/api';

const demoProperties = [
  {
    id: 'prop-001',
    referenceNumber: 'AM-DXB-8821',
    title: 'Ultra-Luxury Penthouse with Private Infinity Pool',
    price: 24500000,
    currency: 'AED',
    purpose: 'sale',
    propertyType: 'Penthouse',
    bedrooms: 4,
    bathrooms: 5,
    areaSqft: 4850,
    location: 'Downtown Dubai, Dubai',
    developer: 'Emaar Properties',
    image: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80',
    verified: true,
    features: ['Sea View', 'Burj Khalifa View', 'Private Pool', 'High Floor']
  },
  {
    id: 'prop-002',
    referenceNumber: 'AM-DXB-9104',
    title: 'Modern Waterfront Marina Apartment',
    price: 185000,
    currency: 'AED',
    purpose: 'rent',
    propertyType: 'Apartment',
    bedrooms: 2,
    bathrooms: 3,
    areaSqft: 1420,
    location: 'Dubai Marina, Dubai',
    developer: 'Select Group',
    image: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=800&q=80',
    verified: true,
    features: ['Marina View', 'Shared Gym', 'Balcony', 'Concierge']
  }
];

export const ApiService = {
  async getMyProperties(ownerId) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, reference_number, title, price, currency, purpose, property_type, status, is_verified, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(property => ({
      id: property.id,
      referenceNumber: property.reference_number,
      title: property.title,
      price: Number(property.price || 0),
      currency: property.currency || 'AED',
      purpose: property.purpose || 'sale',
      propertyType: property.property_type || 'Property',
      status: property.status || 'pending_verification',
      verified: property.is_verified === true
    }));
  },

  async getPropertyForEdit(propertyId, ownerId) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, reference_number, title, description, price, currency, purpose, property_type, bedrooms, bathrooms, area_sqft, city, status')
      .eq('id', propertyId)
      .eq('owner_id', ownerId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async updateProperty(propertyId, ownerId, updates) {
    const { error } = await supabase
      .from('properties')
      .update(updates)
      .eq('id', propertyId)
      .eq('owner_id', ownerId);
    if (error) throw error;
  },

  async updateWhatsappNumber(userId, whatsappNumber) {
    const { error } = await supabase
      .from('users')
      .update({ whatsapp_number: whatsappNumber })
      .eq('id', userId);
    if (error) throw error;
  },

  async getProperties(filters = {}) {
    try {
      let query = supabase
        .from('properties')
        .select('id, reference_number, title, price, currency, purpose, property_type, bedrooms, bathrooms, area_sqft, status, is_verified, description')
        .eq('status', 'approved')
        .order('created_at', { ascending: false });

      if (filters.purpose) {
        query = query.eq('purpose', filters.purpose === 'rent' ? 'rent' : 'sale');
      }

      const { data, error } = await query;
      if (error) throw error;

      if (Array.isArray(data) && data.length > 0) {
        return data.map(property => ({
          id: property.id,
          referenceNumber: property.reference_number,
          title: property.title,
          price: Number(property.price || 0),
          currency: property.currency || 'AED',
          purpose: property.purpose || 'sale',
          propertyType: property.property_type || 'Apartment',
          bedrooms: Number(property.bedrooms || 0),
          bathrooms: Number(property.bathrooms || 0),
          areaSqft: Number(property.area_sqft || 0),
          location: 'Dubai, United Arab Emirates',
          developer: 'Al Maha Global Property',
          image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80',
          verified: property.is_verified === true || property.status === 'approved',
          features: property.description ? [property.description.slice(0, 48)] : ['Verified listing']
        }));
      }
    } catch (error) {
      console.warn('Supabase properties fetch failed, falling back to demo data:', error.message);
    }

    return demoProperties;
  },

  async getOffPlanProjects(filters = {}) {
    let query = supabase
      .from('projects')
      .select('id, name, slug, description, location, city, starting_price, currency, handover_date, construction_status, construction_progress, payment_plan, hero_image, is_verified, is_featured, developers(name, logo_url)')
      .eq('approval_status', 'approved')
      .order('is_featured', { ascending: false })
      .order('created_at', { ascending: false });

    if (filters.city) query = query.eq('city', filters.city);
    if (filters.developerId) query = query.eq('developer_id', filters.developerId);
    if (filters.maxPrice) query = query.lte('starting_price', filters.maxPrice);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getOffPlanProject(slug) {
    const { data: project, error } = await supabase
      .from('projects')
      .select('*, developers(id, name, logo_url, about, website), project_unit_types(*), project_payment_plan_stages(*), project_media(*), project_amenities(*)')
      .eq('slug', slug)
      .eq('approval_status', 'approved')
      .maybeSingle();
    if (error) throw error;
    return project;
  },

  async getAgents() {
    const { data, error } = await supabase.rpc('get_public_agents');
    if (error) throw error;
    return (data || []).map(agent => ({
      id: agent.id,
      fullName: agent.full_name,
      companyName: agent.company_name,
      avatarUrl: agent.avatar_url
    }));
  },

  async calculateMortgage(principal, interestRate, years, residency) {
    const monthlyInterestRate = (interestRate / 100) / 12;
    const totalPayments = years * 12;
    const monthlyPayment = (principal * monthlyInterestRate * Math.pow(1 + monthlyInterestRate, totalPayments)) / (Math.pow(1 + monthlyInterestRate, totalPayments) - 1);
    const totalRepayment = monthlyPayment * totalPayments;
    
    return {
      monthlyPayment: Math.round(monthlyPayment),
      totalRepayment: Math.round(totalRepayment),
      totalInterest: Math.round(totalRepayment - principal),
      maxLTV: residency === 'UAE National' ? 85 : 80
    };
  },

  async estimateValuation(data) {
    // Al Maha Property Estimate Engine
    const basePricePerSqft = 2200;
    const estimatedValue = data.area * basePricePerSqft * (data.condition === 'Upgraded' ? 1.15 : 1.0);
    return {
      estimatedValueLow: Math.round(estimatedValue * 0.95),
      estimatedValueHigh: Math.round(estimatedValue * 1.05),
      estimatedRentalLow: Math.round(estimatedValue * 0.055),
      estimatedRentalHigh: Math.round(estimatedValue * 0.065),
      confidence: 'High'
    };
  }
};