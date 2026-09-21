# Supabase Integration

This directory contains Supabase client configuration and utilities for the application.

## Files

- `client.js` - Supabase client initialization
- `hooks.js` - React hooks for Supabase integration
- `index.js` - Main export file

## Usage

### Basic Import

```javascript
import { supabase } from './supabase'

// Query data
const { data, error } = await supabase
  .from('table_name')
  .select('*')

// Insert data
const { data, error } = await supabase
  .from('table_name')
  .insert({ column: 'value' })

// Update data
const { data, error } = await supabase
  .from('table_name')
  .update({ column: 'new_value' })
  .eq('id', 1)

// Delete data
const { data, error } = await supabase
  .from('table_name')
  .delete()
  .eq('id', 1)
```

### Using the Hook

```javascript
import { useSupabase } from './supabase'

function MyComponent() {
  const { supabase, user, session, loading } = useSupabase()

  if (loading) return <div>Loading...</div>

  return (
    <div>
      {user ? (
        <p>Logged in as: {user.email}</p>
      ) : (
        <p>Not logged in</p>
      )}
    </div>
  )
}
```

### Authentication

```javascript
import { supabase } from './supabase'

// Sign up
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'password123'
})

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password123'
})

// Sign out
const { error } = await supabase.auth.signOut()
```

### Real-time Subscriptions

```javascript
import { supabase } from './supabase'

// Subscribe to changes
const subscription = supabase
  .channel('table_changes')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'table_name' },
    (payload) => {
      console.log('Change received!', payload)
    }
  )
  .subscribe()

// Unsubscribe when component unmounts
return () => {
  subscription.unsubscribe()
}
```
