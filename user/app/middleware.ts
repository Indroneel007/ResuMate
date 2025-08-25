import { authMiddleware } from '@descope/nextjs-sdk/server'
 
export default authMiddleware({
	// The Descope project ID to use for authentication
	// Defaults to process.env.NEXT_PUBLIC_DESCOPE_PROJECT_ID
	projectId: process.env.DESCOPE_PROJECT_ID,
    publicRoutes: ['/', '/sign-in', '/api/public*'],

})
 
export const config = {
	matcher: ['/((?!.+\\.[\\w]+$|_next).*)', '/', '/(api|trpc)(.*)']
}