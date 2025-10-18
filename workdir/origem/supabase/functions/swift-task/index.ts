// hello-world Edge Function
// Minimal Deno + Supabase Edge Function that returns JSON "hello world"
Deno.serve(async (req)=>{
  try {
    const data = {
      message: "hello world"
    };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // keep-alive recommended for Supabase Edge Functions
        "Connection": "keep-alive"
      }
    });
  } catch (err) {
    const errorBody = {
      error: "internal_error",
      details: String(err)
    };
    return new Response(JSON.stringify(errorBody), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
