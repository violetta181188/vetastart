function createMailer(env, {createTransport=require('nodemailer').createTransport, fetchImpl=fetch}={}) {
  if (env.RESEND_API_KEY) {
    if (env.VETASTART_MAIL_ENABLED !== 'true' || !/^\S+@[^\s@]+\.[^\s@]+$/.test(env.MAIL_FROM || '')) {
      throw new Error('Mail is not configured');
    }
    return async ({to, subject, text}) => {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json'},
        body: JSON.stringify({from: env.MAIL_FROM, to: [to], subject, text}),
        signal: AbortSignal.timeout(10000),
        redirect: 'error'
      });
      if (!response.ok) throw new Error('Mail delivery not accepted');
    };
  }
  const port=Number(env.SMTP_PORT||465);
  if(env.VETASTART_MAIL_ENABLED!=='true'||!env.SMTP_HOST||!env.SMTP_USER||!env.SMTP_PASSWORD||
    ![465,587].includes(port)||!/^\S+@[^\s@]+\.[^\s@]+$/.test(env.MAIL_FROM||''))throw new Error('Mail is not configured');
  const transport=createTransport({host:env.SMTP_HOST,port,secure:port===465,requireTLS:true,
    auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
    logger:false,debug:false});
  return async message=>{
    const result=await transport.sendMail({...message,from:env.MAIL_FROM,disableFileAccess:true,disableUrlAccess:true});
    if(!result.accepted?.length)throw new Error('Mail delivery not accepted');
  };
}
module.exports={createMailer};
