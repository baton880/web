import { AsyncLocalStorage } from 'node:async_hooks'
const context = new AsyncLocalStorage()
export const inCalculationContext = () => context.getStore() === true
export const withCalculationContext = action => context.run(true, action)
