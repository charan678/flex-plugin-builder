const defaultOptions = {
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      lines: 100,
      functions: 100,
    },
  },
};

module.exports = (pkg, options) => {
  options = options || {};

  return {
    name: pkg.name,
    displayName: pkg.name,
    collectCoverage: false,
    coverageReporters: ['json', 'text'],
    coverageDirectory: '<rootDir>/../../coverage',
    collectCoverageFrom: [
      '<rootDir>/src/**/*.ts',
      '!<rootDir>/src/**/*.d.ts',
      '!<rootDir>/src/**/*.test.ts',
      '!<rootDir>/src/**/index.ts',
      '!<rootDir>/src/**/prints/**/*.ts',
    ],
    setupFiles: ['<rootDir>/../../jest.setup.js'],
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    testMatch: ['<rootDir>/src/**/*.test.ts'],
    transform: {
      '^.+\\.js?$': '<rootDir>/../../node_modules/babel-jest',
    },
    testPathIgnorePatterns: ['/node_modules/'],
    coveragePathIgnorePatterns: ['/node_modules/'],
    ...defaultOptions,
    ...options,
  };
};