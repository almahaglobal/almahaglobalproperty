class StateManager {
  constructor() {
    this.state = {
      user: null,
      language: localStorage.getItem('al_maha_language') || 'en',
      currency: 'AED',
      exchangeRates: {
        AED: 1.0,
        USD: 0.27,
        EUR: 0.25,
        GBP: 0.21,
        CNY: 1.96,
        RUB: 9.3
      },
      favorites: JSON.parse(localStorage.getItem('al_maha_favorites')) || [],
      savedSearches: JSON.parse(localStorage.getItem('al_maha_searches')) || [],
      comparedProperties: [],
      filters: {
        purpose: 'sale',
        propertyType: '',
        location: '',
        minPrice: 0,
        maxPrice: 50000000,
        bedrooms: 'any'
      }
    };
    this.listeners = [];
  }

  getState() {
    return this.state;
  }

  setState(newState) {
    this.state = { ...this.state, ...newState };
    if (newState.language) localStorage.setItem('al_maha_language', newState.language);
    if (newState.currency) localStorage.setItem('al_maha_currency', newState.currency);
    localStorage.setItem('al_maha_favorites', JSON.stringify(this.state.favorites));
    localStorage.setItem('al_maha_searches', JSON.stringify(this.state.savedSearches));
    this.listeners.forEach(listener => listener(this.state));
  }

  subscribe(listener) {
    this.listeners.push(listener);
  }
}

export const store = new StateManager();