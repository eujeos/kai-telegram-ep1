// ================================================================
// KAI - BOT EXCLUSIVO DO TELEGRAM (projeto novo, separado do server.js
// original que atende WhatsApp+Telegram). Por enquanto, so o Episodio 1
// "A Anomalia" esta implementado - resto da temporada vem depois.
//
// Modelo de negocio NOVO: pagamento UNICO libera a temporada inteira
// (Episodios 1-4+), nao mais cobranca por partida/episodio.
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Cache-buster pra midia (imagem/audio): o Telegram guarda em cache o
// arquivo buscado numa URL - se so trocarmos o conteudo do arquivo
// mantendo o mesmo nome, o Telegram pode continuar servindo a versao
// antiga. Esse valor muda a cada reinicio do servidor (cada deploy),
// forcando o Telegram a buscar a versao mais recente depois de cada
// atualizacao de asset.
const MIDIA_CACHE_BUSTER = Date.now();

// PENDENCIA: definir o preco real da temporada - valor abaixo e' so
// placeholder, ajustar antes de ir pra producao.
const PRECO_SEASON = { numero: 14.90, texto: 'R$14,90' };

app.use('/midia', express.static(path.join(__dirname, 'midia')));

// ---------------- Banco de usuarios (JSON simples em arquivo) ----------------
const CAMINHO_BANCO = path.join(__dirname, 'banco.json');
function carregarBanco() {
  try {
    if (!fs.existsSync(CAMINHO_BANCO)) return {};
    return JSON.parse(fs.readFileSync(CAMINHO_BANCO, 'utf-8'));
  } catch (e) {
    console.error('Erro ao carregar banco:', e.message || e);
    return {};
  }
}
function salvarBanco(banco) {
  try {
    fs.writeFileSync(CAMINHO_BANCO, JSON.stringify(banco, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco:', e.message || e);
  }
}
function getUsuario(identificador) {
  const banco = carregarBanco();
  if (!banco[identificador]) {
    banco[identificador] = {
      estado: 'novo',
      nomeJogador: null,
      tratamentoJogador: null,
      pagou: false,
      pagamentoPendente: null,
      partida: null
    };
    salvarBanco(banco);
  }
  return banco[identificador];
}
function salvarUsuario(identificador, user) {
  const banco = carregarBanco();
  banco[identificador] = user;
  salvarBanco(banco);
}

// ---------------- Deduplicacao de mensagens (evita reprocessar updates repetidos do Telegram) ----------------
const idsProcessados = new Set();
function jaProcessada(id) {
  if (idsProcessados.has(id)) return true;
  idsProcessados.add(id);
  if (idsProcessados.size > 2000) {
    const primeiro = idsProcessados.values().next().value;
    idsProcessados.delete(primeiro);
  }
  return false;
}

// ---------------- Envio de mensagens/midia (Telegram puro, sem Twilio) ----------------
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enviar(chatId, texto) {
  if (!texto || typeof texto !== 'string' || texto.trim() === '') {
    console.error('AVISO: tentativa de enviar mensagem vazia.');
    texto = 'Opa, tive um probleminha aqui - manda de novo?';
  }
  // SEM parse_mode de proposito: varios textos do roteiro tem "_" literal
  // (SISTEMA_INICIADO, SISTEMA_INVADIDO...) que o parser Markdown do
  // Telegram tentaria interpretar como italico e quebraria a mensagem.
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar mensagem:', resposta.status, await resposta.text());
    }
  } catch (err) {
    console.error('Erro de rede ao enviar mensagem:', err.message || err);
  }
}

// Unica mensagem do episodio que precisa de formatacao de verdade (bloco
// de codigo com tres crases, pro "print de sistema") - isolada numa funcao
// separada, pra nao arriscar quebrar o resto das mensagens com parse_mode.
async function enviarComFormatacao(chatId, texto) {
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar mensagem formatada (tentando sem formatacao):', resposta.status, await resposta.text());
      await enviar(chatId, texto.replace(/```/g, ''));
    }
  } catch (err) {
    console.error('Erro de rede ao enviar mensagem formatada:', err.message || err);
    await enviar(chatId, texto.replace(/```/g, ''));
  }
}

async function enviarImagem(chatId, nomeArquivo, textoAlternativo) {
  const urlPublica = `${BASE_URL}/midia/${nomeArquivo}?v=${MIDIA_CACHE_BUSTER}`;
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: urlPublica })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar imagem:', resposta.status, await resposta.text());
      await enviar(chatId, textoAlternativo);
    }
  } catch (err) {
    console.error('Erro de rede ao enviar imagem:', err.message || err);
    await enviar(chatId, textoAlternativo);
  }
}

async function enviarAudio(chatId, nomeArquivo, textoAlternativo) {
  const urlPublica = `${BASE_URL}/midia/${nomeArquivo}?v=${MIDIA_CACHE_BUSTER}`;
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendVoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, voice: urlPublica })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar audio:', resposta.status, await resposta.text());
      await enviar(chatId, textoAlternativo);
    }
  } catch (err) {
    console.error('Erro de rede ao enviar audio:', err.message || err);
    await enviar(chatId, textoAlternativo);
  }
}

// Envia mensagem com botoes inline (teclado). `botoes` e' uma matriz de
// linhas, cada linha uma lista de { texto, callback_data }.
async function enviarBotoes(chatId, texto, botoes) {
  if (!texto || typeof texto !== 'string' || texto.trim() === '') {
    console.error('AVISO: tentativa de enviar mensagem com botoes vazia.');
    texto = 'Opa, tive um probleminha aqui - manda de novo?';
  }
  try {
    const teclado = botoes.map(linha => linha.map(b => ({ text: b.texto, callback_data: b.callback_data })));
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        reply_markup: { inline_keyboard: teclado }
      })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar mensagem com botoes:', resposta.status, await resposta.text());
      await enviar(chatId, texto);
    }
  } catch (err) {
    console.error('Erro de rede ao enviar mensagem com botoes:', err.message || err);
    await enviar(chatId, texto);
  }
}

// Responde ao callback_query (obrigatorio pro Telegram parar o "carregando"
// no botao que o usuario tocou). textoToast e' opcional (popup rapido).
async function responderCallback(callbackQueryId, textoToast) {
  try {
    await fetch(`${TELEGRAM_API_BASE}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: textoToast })
    });
  } catch (err) {
    console.error('Erro ao responder callback query:', err.message || err);
  }
}

// ---------------- Mercado Pago (pagamento UNICO da temporada) ----------------
const referenciasPagamento = {};

async function criarPreferenciaSeason(chatId) {
  if (!MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN nao configurado - nao e possivel gerar cobranca.');
    return null;
  }
  // AVISO: se BASE_URL nao estiver configurado como variavel de ambiente no
  // Railway, cai no fallback localhost - e o Mercado Pago REJEITA
  // notification_url que nao seja publica, fazendo a preferencia falhar.
  if (BASE_URL.includes('localhost')) {
    console.error('AVISO: BASE_URL esta em localhost - configure a variavel de ambiente BASE_URL com a URL publica do Railway, senao a criacao da preferencia Mercado Pago vai falhar.');
  }
  const referencia = `${chatId}__${Date.now()}`;
  try {
    const resposta = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [{
          title: 'Kai - Temporada 1 completa',
          quantity: 1,
          unit_price: PRECO_SEASON.numero,
          currency_id: 'BRL'
        }],
        external_reference: referencia,
        notification_url: `${BASE_URL}/webhook/mercadopago`
      })
    });
    if (!resposta.ok) {
      const corpoErro = await resposta.text();
      console.error('Erro ao criar preferencia Mercado Pago:', resposta.status, corpoErro);
      return null;
    }
    const dados = await resposta.json();
    referenciasPagamento[referencia] = { chatId };
    return { linkPagamento: dados.init_point, referencia };
  } catch (e) {
    console.error('Erro de rede ao criar preferencia Mercado Pago:', e.message || e);
    return null;
  }
}

async function pagamentoAprovado(referencia) {
  if (!MP_ACCESS_TOKEN || !referencia) return false;
  try {
    const resposta = await fetch(
      `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(referencia)}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );
    if (!resposta.ok) return false;
    const dados = await resposta.json();
    return (dados.results || []).some(p => p.status === 'approved');
  } catch (e) {
    console.error('Erro de rede ao consultar pagamento:', e.message || e);
    return false;
  }
}

// ---------------- IA (Claude) - 1 unica chamada nesse episodio ----------------
async function chamarIATextoLivre(systemPrompt, userMessage, maxTokens = 300) {
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY nao configurada.');
    return null;
  }
  try {
    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    if (!resposta.ok) {
      console.error('Erro na chamada da IA:', resposta.status, await resposta.text());
      return null;
    }
    const dados = await resposta.json();
    const textoResposta = (dados.content || []).map(b => b.text || '').join('').trim();
    return textoResposta || null;
  } catch (e) {
    console.error('Erro de rede na chamada da IA:', e.message || e);
    return null;
  }
}

// Prompt pra reacao do Kai a "qual foi a primeira coisa estranha que voce
// percebeu" - baseado literalmente nas instrucoes do roteiro. Unica chamada
// de IA do Episodio 1 inteiro.
async function gerarReacaoPrimeiraCoisaEstranha(respostaJogador) {
  const systemPrompt = `Você é o Kai, protagonista de uma série cinematográfica interativa de suspense vivida pelo WhatsApp/Telegram. Escreva como um personagem real: carismático, inteligente, espontâneo e cinematográfico. Você domina storytelling e suspense, gerando respostas curtas, naturais e BEM envolventes.

O jogador acabou de responder à pergunta "Olhe bem a imagem novamente. Qual foi a primeira coisa estranha que você percebeu?" - a resposta dele está na mensagem do usuário abaixo.

O seu objetivo é fazer parecer que Kai realmente analisou a resposta do jogador. Nunca diga que ele está errado. Aproveite a percepção dele como ponto de partida e conduza naturalmente para a verdadeira descoberta.

A resposta deve revelar, sem parecer uma explicação, usando EXATAMENTE estes fatos (nunca invente datas ou nomes diferentes destes - use só o que está listado aqui):
- O registro foi criado em 21/04/1977 (data exata - não arredonde nem troque o ano).
- Kai só foi criado no fim dos anos 80.
- Portanto, esse registro existia antes do próprio Kai existir, e isso desafia toda a lógica.
- A origem do registro aponta pro John — o único criador que Kai sempre acreditou ter.
- Existe outro detalhe ainda mais estranho: tem um segundo nome anotado ali também, abreviado só como "W.". Kai nunca soube de um segundo criador.

Finalize aumentando o mistério com uma pergunta ou observação forte sobre quem é W.

REGRA DE FORMATO - MUITO IMPORTANTE (siga à risca):
- Responda em NO MÁXIMO 3 linhas curtas.
- Separe CADA linha com o delimitador "|||" (três pipes, sem espaço) - por exemplo: "linha 1|||linha 2|||linha 3". NÃO use quebra de linha normal, use SEMPRE "|||" entre as linhas.
- Frases curtas, naturais, cinematográficas - Kai pensando em voz alta.
- Gere curiosidade, faça o jogador sentir que está investigando junto com Kai.
- Nunca pareça um chatbot ou um narrador.`;

  const resultado = await chamarIATextoLivre(systemPrompt, respostaJogador, 220);
  if (!resultado) return null;
  // Divide pelo delimitador "|||" pedido no prompt e junta com linha em
  // branco - mais confiavel do que esperar que a IA insira \n\n sozinha.
  return resultado
    .split('|||')
    .map(linha => linha.trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------------- Jogo do numero (par/impar) - algoritmo Bellos ----------------
const ADIVINHA_TOP30_BELLOS = [
  [7,9.7],[3,7.5],[8,6.7],[4,5.6],[5,5.1],[13,5.0],[9,4.8],[6,3.4],[2,3.4],[11,2.9],
  [42,2.8],[17,2.7],[23,2.3],[12,2.2],[27,1.9],[22,1.5],[21,1.4],[14,1.3],[24,1.2],
  [1,1.2],[16,1.2],[10,1.2],[37,1.0],[0,1.0],[19,0.9],[18,0.8],[28,0.7],[69,0.6]
];
const NUMERO_POOL_INICIAL = [7, 3, 8];
const NUMERO_PULAR = [2];

function bellosPeso(n) {
  const entrada = ADIVINHA_TOP30_BELLOS.find(([num]) => num === n);
  return entrada ? entrada[1] : null;
}
function numeroSortearPonderado(pool) {
  const total = pool.reduce((soma, n) => soma + (bellosPeso(n) || 0.1), 0);
  let r = Math.random() * total;
  for (const n of pool) {
    r -= (bellosPeso(n) || 0.1);
    if (r <= 0) return n;
  }
  return pool[pool.length - 1];
}
function numeroExpandirPool(poolAtual, chutado, idxRanking, tentados) {
  const ranking = ADIVINHA_TOP30_BELLOS.map(([n]) => n);
  const novoPool = poolAtual.filter(n => n !== chutado);
  let idx = idxRanking;
  let adicionados = 0;
  while (adicionados < 3 && idx < ranking.length) {
    const candidato = ranking[idx];
    idx++;
    if (NUMERO_PULAR.includes(candidato)) continue;
    if (!novoPool.includes(candidato) && !tentados.includes(candidato)) {
      novoPool.push(candidato);
      adicionados++;
    }
  }
  return { pool: novoPool, idxRanking: idx };
}
function numeroFiltrarPool(pool, paridadePar) {
  if (paridadePar === null || paridadePar === undefined) return pool;
  const filtrado = pool.filter(n => (n % 2 === 0) === paridadePar);
  return filtrado.length > 0 ? filtrado : pool;
}

// ================================================================
// EPISODIO 1 - "A Anomalia" (roteiro completo, Telegram-only)
// ================================================================

async function iniciarEpisodio1(chatId, user) {
  await enviar(chatId, 'SISTEMA_INICIADO (#1_PILOT)');
  await esperar(2000);
  // PENDENCIA: video real do Kai se apresentando e travando - placeholder
  // de texto por enquanto.
  await enviar(chatId, '🎥 (Kai começa a se apresentar, explicando o jogo... o vídeo trava)');
  await esperar(3000);
  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarImagem(chatId, 'tela-celular.png', 'W. ██████.: E aí, você sabe quem eu sou? Eu sei muito mais sobre você, mais do que você imagina.');
  await esperar(10000); // imagem - buffer de latencia de entrega
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1000);
  await enviar(chatId, 'Kai: W.? Como isso é possível, ele não deveria conseguir entrar aqui!');
  await esperar(2000);
  await enviar(chatId, 'Kai: Ei, você que veio para o meu desafio, não vá embora! Vou tentar resolver isso rápido.');
  await esperar(2000);

  await enviarBotoes(chatId, 'Kai: Só confirma uma coisa antes... como você tá se sentindo agora?', [[
    { texto: '👀 Curioso', callback_data: 'op1_sentimento:curioso' },
    { texto: '😨 Meio nervoso', callback_data: 'op1_sentimento:nervoso' },
    { texto: '🍿 Bora ver isso', callback_data: 'op1_sentimento:bora' }
  ]]);
  user.estado = 'aguardando_sentimento_ep1';
  salvarUsuario(chatId, user);
}

// Enquete de abertura - flavor puro, nao influencia o resto do jogo.
const FLAVOR_SENTIMENTO = {
  curioso: 'Kai: Gostei dessa energia. Vem comigo.',
  nervoso: 'Kai: Relaxa, eu também tô meio surtado aqui, mas vamos juntos.',
  bora: 'Kai: Isso aí! Essa é a atitude que eu precisava.'
};

async function continuarAposSentimento(chatId, user, escolha) {
  await enviar(chatId, FLAVOR_SENTIMENTO[escolha] || 'Kai: Bora nessa.');
  await esperar(2000);
  await continuarAposEsperaInicial(chatId, user);
}

async function continuarAposEsperaInicial(chatId, user) {
  await enviar(chatId, '🔍 Varredura em andamento...');
  await esperar(2000);
  await enviar(chatId, '❌ Erro: falha na varredura.');
  await esperar(2000);
  await enviar(chatId, 'Kai: Não vou conseguir resolver isso sozinho... e acho que é maior do que uma simples invasão.');
  await esperar(3000);
  await enviar(chatId, 'Kai: Então, se vamos encarar isso juntos — como posso te chamar?');
  user.estado = 'aguardando_nome_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposNome(chatId, user, texto) {
  const nome = (texto || '').trim().slice(0, 40) || 'desafiante';
  user.nomeJogador = nome;
  await enviar(chatId, `Kai: ${nome}. Prazer, eu sou o KAI — e os meus planos pra hoje definitivamente não eram esses.`);
  await esperar(2000);
  await enviarBotoes(chatId, 'Kai: Prefere que eu fale do meu jeito... ou daquele jeito formal (engomadinho, cheio de "prezado" e "cordialmente")?', [[
    { texto: '😎 Modo Kai', callback_data: 'op1_tratamento:kai' },
    { texto: '🎩 Modo Formal', callback_data: 'op1_tratamento:formal' }
  ]]);
  user.estado = 'aguardando_tratamento_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposTratamento(chatId, user, escolha) {
  // NOTA: o termo de tratamento usado pelo Kai fica fixo em "cara"
  // independente da escolha (comportamento herdado do server.js original) -
  // so a reacao do Kai muda entre os dois modos.
  const termo = 'cara';
  user.tratamentoJogador = termo;

  if (escolha === 'formal') {
    await enviar(chatId, 'Kai: Engomadinho? Você superestima minha capacidade de parecer sério 😂 Confesso, era só teste — acabou de desbloquear o modo master do Kai.');
  } else {
    await enviar(chatId, 'Kai: Já gostei de você! 🤝 O modo "Kai" costuma render bastante.');
  }
  await esperar(2000);

  await enviar(chatId, 'Kai: Agora... tem uma coisa estranha aqui. Um registro?');
  await esperar(2000);
  await enviarImagem(chatId, 'status-bloqueado.png', '🖥️ Registro encontrado. Status: Bloqueado.');
  await esperar(9000); // imagem - buffer de latencia
  await enviar(chatId, 'Kai: Ele nunca deveria ter aparecido pra mim — e algo me diz que o que tem aí dentro responde mais perguntas do que eu gostaria.');
  await esperar(3800); // um pouco mais de tempo pra pessoa processar, mantendo a pressao
  await enviar(chatId, 'Kai: Pra abrir, tem um desafio. Pensa rápido: qual o primeiro número que surge na sua mente? NÃO RESPONDA!');
  await esperar(2200);
  await enviar(chatId, '3');
  await esperar(2200);
  await enviar(chatId, '2');
  await esperar(2200);
  await enviar(chatId, '1');
  await esperar(1500);

  user.partida = {
    pool: [...NUMERO_POOL_INICIAL],
    idxRanking: NUMERO_POOL_INICIAL.length,
    tentados: [],
    paridadeRevelada: null
  };
  const chute = numeroSortearPonderado(user.partida.pool);
  user.partida.chuteAtual = chute;
  user.partida.tentados.push(chute);
  user.partida.tentativa = 1;
  user.estado = 'jogando_numero_ep1';
  salvarUsuario(chatId, user);

  await enviarBotoes(chatId, `Tentativa 1: é o número ${chute}.`, [[
    { texto: '🎯 Acertou', callback_data: 'op1_numero:acertou' },
    { texto: '❌ Errou', callback_data: 'op1_numero:errou' }
  ]]);
}

// Rodada do jogo do numero - ate 3 tentativas, com uma pergunta de paridade
// no meio se a 1a tentativa errar. Agora dirigido por botoes (callback_query),
// nao mais por texto livre.
async function processarRodadaNumeroCallback(chatId, user, escolha) {
  const p = user.partida;

  if (p.aguardandoParidade) {
    const par = escolha === 'par';
    p.paridadeRevelada = par;
    p.aguardandoParidade = false;
    p.pool = numeroFiltrarPool(p.pool, par);
    salvarUsuario(chatId, user);
    await continuarProximaTentativaNumero(chatId, user);
    return;
  }

  if (escolha === 'acertou') {
    await finalizarJogoNumero(chatId, user, true);
    return;
  }

  // Errou - se foi a 1a tentativa, pergunta paridade antes de continuar.
  if (p.tentativa === 1 && p.paridadeRevelada === null) {
    p.aguardandoParidade = true;
    salvarUsuario(chatId, user);
    await enviarBotoes(chatId, 'Antes de continuar — é par ou ímpar?', [[
      { texto: '✌️ Par', callback_data: 'op1_paridade:par' },
      { texto: '☝️ Ímpar', callback_data: 'op1_paridade:impar' }
    ]]);
    return;
  }

  if (p.tentativa >= 3) {
    await finalizarJogoNumero(chatId, user, false);
    return;
  }

  await continuarProximaTentativaNumero(chatId, user);
}

async function continuarProximaTentativaNumero(chatId, user) {
  const p = user.partida;
  const { pool, idxRanking } = numeroExpandirPool(p.pool, p.chuteAtual, p.idxRanking, p.tentados);
  p.pool = pool;
  p.idxRanking = idxRanking;
  const chute = numeroSortearPonderado(p.pool);
  p.chuteAtual = chute;
  p.tentados.push(chute);
  p.tentativa++;
  salvarUsuario(chatId, user);
  await esperar(1200); // pausa curta - efeito "Kai pensando" antes do proximo chute
  await enviarBotoes(chatId, `Tentativa ${p.tentativa}: é o número ${chute}.`, [[
    { texto: '🎯 Acertou', callback_data: 'op1_numero:acertou' },
    { texto: '❌ Errou', callback_data: 'op1_numero:errou' }
  ]]);
}

async function finalizarJogoNumero(chatId, user, kaiAcertou) {
  if (kaiAcertou) {
    await enviar(chatId, 'Kai: Às vezes até eu me surpreendo comigo mesmo! Olha isso... O registro abriu 🔓');
  } else {
    await enviar(chatId, 'Kai: Errei 😅');
    await esperar(1500);
    await enviar(chatId, 'Ou nem tanto assim, o último número que eu falei acabou de desbloquear o registro 🔓');
  }
  await esperar(2500);

  await enviarImagem(chatId, 'registro-37.png', '🖥️ Registro #0037 - Origem: John, WAY');
  await esperar(10000); // imagem - revelacao mais importante do episodio, buffer maior
  await enviar(chatId, 'Kai: Pera... isso só pode ser zoação com a minha cara, não é possível.');
  await esperar(2500);
  await enviar(chatId, 'Kai: Olhe bem a imagem novamente! Qual foi a primeira coisa estranha que você percebeu?');
  user.estado = 'aguardando_reacao_imagem_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposReacaoImagem(chatId, user, texto) {
  const reacao = await gerarReacaoPrimeiraCoisaEstranha(texto);
  if (reacao) {
    await enviar(chatId, reacao);
    await esperar(4000); // texto com 3 linhas + espacamento - mais tempo de leitura
  } else {
    // Fallback fixo (max 3 linhas, com espacamento), caso a IA falhe - garante que o episodio nunca trava.
    await enviar(chatId, 'Kai: Interessante você ter notado isso... mas tem algo bem mais estranho.\n\nEsse registro é de 21/04/1977 — antes de eu sequer existir. A origem aponta pro John, meu criador. Só que tem um segundo nome anotado ali: "W."\n\nQuem diabos é esse W.?');
    await esperar(4000);
  }

  await enviar(chatId, 'Kai: Eu preciso de mais respostas! Mas isso vai demorar pra carregar...');
  await esperar(2000);
  await enviar(chatId, 'Kai: Enquanto isso — me conta algo sobre você. Um hobby, um sonho, uma mania.');
  user.estado = 'aguardando_hobby_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposHobby(chatId, user, texto) {
  // Guarda a resposta - primeiro ponto do dossie pessoal, reaproveitavel
  // nos proximos episodios (Armadilha, etc).
  user.dossie = user.dossie || {};
  user.dossie.hobby_sonho_mania = (texto || '').trim().slice(0, 300);

  await enviar(chatId, 'Kai: Interess... isso não é possível!');
  await esperar(2500);
  await enviar(chatId, `${user.nomeJogador || 'Você'}...`);
  await esperar(2000);

  // Print de sistema: compatibilidade alta e variavel (90-98%), categoria
  // arquivada num ano aleatorio entre 1977-1980 (antes do Kai existir), e a
  // descricao e' o proprio texto do jogador cortado (nao parafraseado por
  // IA aqui - esse print E' pra parecer OBVIAMENTE ligado ao que ele disse,
  // nao sutil).
  const compatibilidade = 90 + Math.floor(Math.random() * 9); // 90-98%
  const anoArquivo = 1977 + Math.floor(Math.random() * 4);
  const descBruta = user.dossie.hobby_sonho_mania;
  const descCortada = descBruta.length > 28 ? descBruta.slice(0, 28) : descBruta;
  const printSistema = `\`\`\`\nD: PADRÃO-██\nCompatibilidade: ${compatibilidade}%\nCategoria arquivada em: ${anoArquivo}\n${descCortada}#%@$...\n\`\`\``;
  await enviarComFormatacao(chatId, printSistema);
  await esperar(5000);

  await enviar(chatId, `Kai: ${user.nomeJogador || 'você'}, o que você acabou de me contar não é novo por aqui. Tem um padrão parecido, arquivado há décadas — antes de eu ser criado!`);
  await esperar(3000);
  await enviar(chatId, 'Kai: Calma, não me abandone. Deixa eu analisar de novo — 5 segundos.');
  await esperar(5000);
  await enviar(chatId, 'Kai: Voltei. Achei um documento. Pra abrir, pede uma sequência... mas que sequência é essa?');
  await esperar(1500);

  await enviarBotoes(chatId, 'Kai: Se você fosse chutar de olhos fechados... que tipo de sequência guardaria um segredo desses?', [[
    { texto: '🔢 Uma data', callback_data: 'op1_seq:data' },
    { texto: '🔑 Uma senha antiga', callback_data: 'op1_seq:senha' },
    { texto: '🧬 Um código genético', callback_data: 'op1_seq:genetico' }
  ]]);
  user.estado = 'aguardando_sequencia_documento_ep1';
  salvarUsuario(chatId, user);
}

// Enquete sobre a sequencia do documento - flavor, sem efeito no jogo.
const FLAVOR_SEQUENCIA = {
  data: 'Kai: Data... pode ser. Todo mistério bom começa com uma data, né?',
  senha: "Kai: Senha antiga eu até aceito. Só espero que não seja '123456'.",
  genetico: 'Kai: Ousado. Se for isso, aí sim eu tô mesmo encrencado.'
};

async function continuarAposSequencia(chatId, user, escolha) {
  await enviar(chatId, FLAVOR_SEQUENCIA[escolha] || 'Kai: Boa hipótese.');
  await esperar(2000);
  await continuarInvasaoBecoSemSaida(chatId, user);
}

async function continuarInvasaoBecoSemSaida(chatId, user) {
  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarAudio(chatId, 'voz-w.mp3', '🔊 (áudio - "Kai... É o W. Não continue por esse caminho. Algumas portas... existem por um motivo.")');
  // PENDENCIA: ajustar para duracao real do audio + ~3-4s de buffer assim
  // que o arquivo final estiver gravado - valor abaixo e' estimativa.
  await esperar(13000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, 'Kai: Por muito pouco... O W. entrou no meu sistema, estou sem controle total.');
  await esperar(2000);

  await enviarImagem(chatId, 'beco-s-saida.png', '📄 DOCUMENTO #0087 - Protocolo: BECO_SEM_SAÍDA - Status: Pendente');
  await esperar(9000);

  await enviar(chatId, 'Kai: Protegido por um número proibido. Precisamos descobrir qual é. Mas antes... o que será que tem aí pra alguém esconder assim?');
  await esperar(1500);

  await enviarBotoes(chatId, 'Kai: Confia em mim e chuta... por que será que alguém trancaria isso tão fundo assim?', [[
    { texto: '🗝️ Algo que era pra ficar esquecido', callback_data: 'op1_protocolo:esquecido' },
    { texto: '⚠️ Algo perigoso demais pra mim saber', callback_data: 'op1_protocolo:perigoso' }
  ]]);
  user.estado = 'aguardando_protocolo_beco_ep1';
  salvarUsuario(chatId, user);
}

// Enquete sobre o protocolo do documento - flavor, sem efeito no jogo.
const FLAVOR_PROTOCOLO = {
  esquecido: 'Kai: É, também penso nisso. Tem cara de coisa enterrada de propósito.',
  perigoso: 'Kai: Essa hipótese me deixa mais nervoso ainda... mas vamos descobrir mesmo assim.'
};

async function continuarAposProtocolo(chatId, user, escolha) {
  await enviar(chatId, FLAVOR_PROTOCOLO[escolha] || 'Kai: Pode ser bem isso.');
  await esperar(2000);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarImagem(chatId, 'msg-sis-w-1.png', 'MENSAGEM DO W: "EU ESTOU TE AVISANDO, VOCÊ NÃO ESTÁ PREPARADO!"');
  await esperar(9000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, `Kai: ${user.nomeJogador || 'você'}? Ele voltou de novo — mas dessa vez consegui blindar uma rota alternativa. Essa aqui é firme, não cai como a de antes.`);
  await esperar(2500);
  await enviar(chatId, 'Kai: Dá pra fixar de vez. Uma vez só, vale pra season inteira.');
  await esperar(2500);

  // PENDENCIA: Mercado Pago ainda bloqueado por policy (403
  // PA_UNAUTHORIZED_RESULT_FROM_POLICIES) - resolver isso depois com o
  // suporte do MP. Enquanto isso, em ambiente de TESTE, NAO interrompe o
  // episodio se a preferencia falhar - segue o roteiro ate o fim so sem
  // link real, pra conseguir testar o resto do fluxo. Reverter esse
  // comportamento (voltar a interromper) assim que o MP estiver ok.
  const cobranca = await criarPreferenciaSeason(chatId);
  if (cobranca) {
    user.pagamentoPendente = cobranca.referencia;
    salvarUsuario(chatId, user);
    await enviar(chatId, `Acesse o link para ativar a rota: ${cobranca.linkPagamento}`);
  } else {
    await enviar(chatId, '⚠️ (Ambiente de teste) Link de pagamento indisponível no momento - seguindo com o resto da história.');
  }
  await esperar(2000);
  await enviar(chatId, 'Kai: Recapitulando rápido: um registro meu de antes de eu existir, um tal de W. co-criador, e o sistema já sabia de você antes de eu perguntar.');
  await esperar(3000);
  await enviar(chatId, `Kai: ${user.tratamentoJogador || 'cara'}, guarda isso até eu vol…`);
  await esperar(1500);
  await enviar(chatId, '⚠️ Conexão interrompida em 3...');
  await esperar(1000);
  await enviar(chatId, '2...');
  await esperar(1000);
  await enviar(chatId, '1...');
  await esperar(1000);
  await enviarBotoes(chatId, '🛑 SISTEMA_INVADIDO (#1_PILOT_FINISH)', [[
    { texto: '✅ Já paguei', callback_data: 'op1_pagamento:confirmar' }
  ]]);

  user.estado = 'aguardando_pagamento_season';
  salvarUsuario(chatId, user);
}

// ---------------- Roteador central de mensagens de TEXTO ----------------
async function processarMensagem(chatId, user, texto) {
  if (user.estado === 'novo') {
    await iniciarEpisodio1(chatId, user);
    return;
  }
  if (user.estado === 'aguardando_nome_ep1') {
    await continuarAposNome(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_reacao_imagem_ep1') {
    await continuarAposReacaoImagem(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_hobby_ep1') {
    await continuarAposHobby(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_pagamento_season') {
    if (texto.trim().toLowerCase() === 'paguei') {
      const aprovado = user.pagamentoPendente ? await pagamentoAprovado(user.pagamentoPendente) : false;
      if (aprovado) {
        user.pagou = true;
        user.estado = 'fim_temporada_1_episodio'; // Episodio 2 ainda nao implementado nesse projeto novo
        salvarUsuario(chatId, user);
        await enviar(chatId, 'Online. 🟢');
        await esperar(1500);
        await enviar(chatId, 'Pagamento confirmado! O Episódio 2 ainda está sendo escrito por aqui - volta em breve. 🎬');
        return;
      }
      await enviar(chatId, 'Ainda não encontrei a confirmação do pagamento. Assim que cair, eu libero automaticamente - ou toca no botão "✅ Já paguei" de novo em alguns segundos.');
      return;
    }
    await enviar(chatId, 'A conexão caiu. Toca no botão "✅ Já paguei" ou me manda "paguei" pra eu verificar.');
    return;
  }
  // Estados que agora sao 100% controlados por botao - texto solto so recebe um lembrete.
  const estadosSoBotao = [
    'aguardando_sentimento_ep1',
    'aguardando_tratamento_ep1',
    'jogando_numero_ep1',
    'aguardando_sequencia_documento_ep1',
    'aguardando_protocolo_beco_ep1'
  ];
  if (estadosSoBotao.includes(user.estado)) {
    await enviar(chatId, 'Usa os botões aí em cima pra continuar 👆');
    return;
  }
  // Estado desconhecido/fim de conteudo - resposta generica segura.
  await enviar(chatId, 'Por enquanto é só isso que temos pronto! Volta em breve pro resto da história. 🎬');
}

// ---------------- Roteador central de CALLBACKS (botoes inline) ----------------
// callback_data segue o formato "acao:escolha" (ex: "op1_sentimento:curioso").
async function processarCallback(chatId, user, callbackData) {
  const [acao, escolha] = (callbackData || '').split(':');

  if (user.estado === 'aguardando_sentimento_ep1' && acao === 'op1_sentimento') {
    await continuarAposSentimento(chatId, user, escolha);
    return;
  }
  if (user.estado === 'aguardando_tratamento_ep1' && acao === 'op1_tratamento') {
    await continuarAposTratamento(chatId, user, escolha);
    return;
  }
  if (user.estado === 'jogando_numero_ep1' && (acao === 'op1_numero' || acao === 'op1_paridade')) {
    await processarRodadaNumeroCallback(chatId, user, escolha);
    return;
  }
  if (user.estado === 'aguardando_sequencia_documento_ep1' && acao === 'op1_seq') {
    await continuarAposSequencia(chatId, user, escolha);
    return;
  }
  if (user.estado === 'aguardando_protocolo_beco_ep1' && acao === 'op1_protocolo') {
    await continuarAposProtocolo(chatId, user, escolha);
    return;
  }
  if (user.estado === 'aguardando_pagamento_season' && acao === 'op1_pagamento') {
    const aprovado = user.pagamentoPendente ? await pagamentoAprovado(user.pagamentoPendente) : false;
    if (aprovado) {
      user.pagou = true;
      user.estado = 'fim_temporada_1_episodio'; // Episodio 2 ainda nao implementado nesse projeto novo
      salvarUsuario(chatId, user);
      await enviar(chatId, 'Online. 🟢');
      await esperar(1500);
      await enviar(chatId, 'Pagamento confirmado! O Episódio 2 ainda está sendo escrito por aqui - volta em breve. 🎬');
      return;
    }
    await enviar(chatId, 'Ainda não encontrei a confirmação do pagamento. Assim que cair, eu libero automaticamente - ou toca no botão de novo em alguns segundos.');
    return;
  }
  // Callback fora de contexto (ex: botao antigo tocado de novo apos avancar
  // de estado) - ignora silenciosamente, o usuario ja recebeu o toast do
  // answerCallbackQuery entao nao precisa de mais feedback aqui.
}

// ---------------- Webhooks ----------------
app.post('/telegram', (req, res) => {
  const update = req.body;

  // Toque em botao inline chega como callback_query, nao como message.
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String((cb.message && cb.message.chat && cb.message.chat.id) || cb.from.id);
    const idCallback = `cb:${cb.id}`;
    if (jaProcessada(idCallback)) {
      res.sendStatus(200);
      return;
    }
    res.sendStatus(200);
    responderCallback(cb.id).catch(err => console.error('Erro ao responder callback query:', err.message || err));
    const user = getUsuario(chatId);
    processarCallback(chatId, user, cb.data).catch(err => console.error('Erro ao processar callback:', err));
    return;
  }

  const mensagemRecebida = update.message;
  if (!mensagemRecebida || typeof mensagemRecebida.text !== 'string') {
    res.sendStatus(200);
    return;
  }
  const chatId = String(mensagemRecebida.chat.id);
  const idMensagem = `${chatId}:${mensagemRecebida.message_id}`;
  if (jaProcessada(idMensagem)) {
    res.sendStatus(200);
    return;
  }
  res.sendStatus(200);
  const texto = mensagemRecebida.text.trim();
  const user = getUsuario(chatId);
  processarMensagem(chatId, user, texto).catch(err => console.error('Erro ao processar mensagem:', err));
});

app.post('/webhook/mercadopago', (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const paymentId = req.body?.data?.id;
      if (!paymentId || !MP_ACCESS_TOKEN) return;
      const resposta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      if (!resposta.ok) return;
      const pagamento = await resposta.json();
      if (pagamento.status !== 'approved') return;
      const referencia = pagamento.external_reference;
      const registro = referenciasPagamento[referencia];
      if (!registro) return;
      const chatId = registro.chatId;
      const user = getUsuario(chatId);
      if (user.pagamentoPendente !== referencia || user.pagou) return;
      user.pagou = true;
      user.estado = 'fim_temporada_1_episodio';
      salvarUsuario(chatId, user);
      await enviar(chatId, 'Online. 🟢');
      await esperar(1500);
      await enviar(chatId, 'Pagamento confirmado! O Episódio 2 ainda está sendo escrito por aqui - volta em breve. 🎬');
    } catch (e) {
      console.error('Erro no webhook do Mercado Pago:', e.message || e);
    }
  })();
});

app.get('/', (req, res) => res.send('Kai (Telegram) - Episodio 1 - rodando.'));

app.listen(PORT, () => {
  console.log(`Servidor Kai (Telegram, Episodio 1) rodando na porta ${PORT}`);
});
