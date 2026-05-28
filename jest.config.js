module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/parsers.js'
  ]
};
