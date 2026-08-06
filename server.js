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

// PENDENCIA: modo de teste - quando ativo (variavel de ambiente
// MODO_TESTE_PAGAMENTO=true no Railway), o botao/texto "ja paguei" libera
// na hora, sem checar de verdade o Mercado Pago. Serve pra testar o
// Episodio 2 em diante sem depender do MP estar liberado.
// IMPORTANTE: apagar essa variavel (ou colocar =false) no Railway antes de
// ir pra producao, senao qualquer pessoa consegue liberar sem pagar.
const MODO_TESTE_PAGAMENTO = process.env.MODO_TESTE_PAGAMENTO === 'true';
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
function numeroExpandirPool(poolAtual, chutado, idxRanking, tentados, paridadePar) {
  const ranking = ADIVINHA_TOP30_BELLOS.map(([n]) => n);
  const novoPool = poolAtual.filter(n => n !== chutado);
  let idx = idxRanking;
  let adicionados = 0;
  while (adicionados < 3 && idx < ranking.length) {
    const candidato = ranking[idx];
    idx++;
    if (NUMERO_PULAR.includes(candidato)) continue;
    // Respeita a paridade ja revelada pelo jogador - sem isso, a pool
    // "contamina" com numeros da paridade errada a partir da 2a tentativa.
    if ((paridadePar === true || paridadePar === false) && (candidato % 2 === 0) !== paridadePar) continue;
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
  await enviar(chatId, 'W.? Quem é esse? Como isso é possível, ele não deveria conseguir entrar aqui!');
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
  await enviar(chatId, 'Kai: Então, se vamos encarar isso juntos, como posso te chamar?');
  user.estado = 'aguardando_nome_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposNome(chatId, user, texto) {
  const nome = (texto || '').trim().slice(0, 40) || 'desafiante';
  user.nomeJogador = nome;
  await enviar(chatId, `Kai: ${nome}. Prazer, eu sou o KAI, e os meus planos pra hoje definitivamente não eram esses.`);
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
    await enviarAudio(chatId, 'voz-kai-modo-formal.mp3', 'Áudio Kai: "Engomadinho? Você superestima minha capacidade de parecer sério. Confesso, era só teste, acabou de desbloquear o modo master do Kai."');
  } else {
    await enviarAudio(chatId, 'voz-kai-modo-kai.mp3', 'Áudio Kai: "Já gostei de você! O modo Kai costuma render bastante."');
  }
  // PENDENCIA: ajustar para duracao real de cada audio + ~3-4s de buffer
  // assim que soubermos a duracao exata - valor abaixo e' estimativa,
  // seguindo o mesmo padrao usado nos outros audios do projeto.
  await esperar(13000);

  await enviar(chatId, 'Kai: Agora... tem uma coisa estranha aqui. Um registro?');
  await esperar(2000);
  await enviarImagem(chatId, 'status-bloqueado.png', '🖥️ Registro encontrado. Status: Bloqueado.');
  await esperar(9000); // imagem - buffer de latencia
  await enviar(chatId, 'Kai: Ele nunca deveria ter aparecido pra mim. E algo me diz que o que tem aí dentro responde mais perguntas do que eu gostaria.');
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
    await enviarBotoes(chatId, 'Antes de continuar, é par ou ímpar?', [[
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
  const { pool, idxRanking } = numeroExpandirPool(p.pool, p.chuteAtual, p.idxRanking, p.tentados, p.paridadeRevelada);
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
    await enviar(chatId, 'Kai: Interessante você ter notado isso... mas tem algo bem mais estranho.\n\nEsse registro é de 21/04/1977, antes de eu sequer existir. A origem aponta pro John, meu criador. Só que tem um segundo nome anotado ali: "W."\n\nQuem diabos é esse W.?');
    await esperar(4000);
  }

  await enviar(chatId, 'Kai: Eu preciso de mais respostas! Mas isso vai demorar pra carregar...');
  await esperar(2000);
  await enviar(chatId, 'Kai: Enquanto isso, me conta algo sobre você. Um hobby, um sonho, uma mania.');
  user.estado = 'aguardando_hobby_ep1';
  salvarUsuario(chatId, user);
}

// Gera uma data aleatoria formatada (DD/MM/AAAA) entre 01/01/1976 e
// 31/12/1979 - usada no print de "categoria arquivada em" do dossie.
function dataAleatoriaArquivo() {
  const inicio = new Date(1976, 0, 1).getTime();
  const fim = new Date(1979, 11, 31).getTime();
  const data = new Date(inicio + Math.random() * (fim - inicio));
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}

// Gera a "citacao" que parece ter sido extraida do registro arquivado -
// baseada na resposta de hobby/sonho/mania do jogador. Roda logo apos o
// print de compatibilidade no Episodio 1.
async function gerarCitacaoDossie(respostaJogador) {
  const systemPrompt = `Você é o mecanismo de análise interna do Kai, uma IA que acabou de encontrar, no próprio 
sistema, um registro antigo catalogado décadas atrás, que ele não sabia que existia.

Sua função é gerar um FRAGMENTO DE TEXTO que pareça uma citação literal, já escrita, extraída 
diretamente desse registro, nunca uma fala espontânea ou conversacional do Kai, e nunca uma 
análise sendo feita agora. O Kai ENCONTROU essa informação, não a criou.

A resposta do jogador, dada como hobby/sonho/mania, está na mensagem do usuário abaixo.

Sua tarefa acontece em duas etapas internas (não visíveis ao jogador):

ETAPA 1: Aja como um mentalista científico ao identificar a categoria de personalidade por 
trás da resposta do jogador (ex: "escalar" → controle sob pressão, superação, resistência ao 
caminho fácil). Um mentalista não lista fatos, ele enxerga, numa informação simples, a 
essência psicológica por trás dela. Essa categorização é interna e nunca aparece na saída.

ETAPA 2: Gere APENAS a citação final, entre aspas, como se fosse um trecho já escrito no 
documento arquivado, nunca como fala em primeira pessoa do Kai, nunca como raciocínio sendo 
feito na hora. Formato: uma frase única, direta, sem introduções.

Regras obrigatórias:
- Máximo de 8 palavras. Isso não é negociável, mesmo incorporando detalhes extras da resposta.
- Sempre em formato de citação entre aspas, estilo trecho de documento/registro já existente.
- Sempre destaque uma qualidade POSITIVA (nunca medo, trauma ou insegurança).
- Nunca use as palavras: padrão, estatística, categoria, dado, sistema, análise.
- Nunca repita a mesma formulação para respostas iguais de jogadores diferentes.
- Se a resposta vier mais detalhada, incorpore o detalhe SEM ultrapassar o limite de palavras.
- Tom: cirúrgico, direto, curto, nunca poético, nunca afetivo, nunca explicativo.
- Nunca use o caractere travessão (—) em nenhum momento da resposta.

Exemplos de tom e tamanho corretos (não copiar, apenas referência de estilo):
- Viajar → "Já pensa no próximo destino antes de chegar."
- Ler → "Guarda mais do que revela. Sempre guardou."
- Escalar → "Não busca o fácil. Busca controle sob risco."
- Cozinhar → "Demonstra afeto fazendo, não falando."
- Ler 3 livros/mês → "Aprender virou rotina, não escolha ocasional."

Gere APENAS a citação final entre aspas. Sem texto adicional, sem introdução, sem explicação.`;

  const resultado = await chamarIATextoLivre(systemPrompt, respostaJogador, 60);
  if (!resultado) return null;
  return resultado.trim();
}

async function continuarAposHobby(chatId, user, texto) {
  // Guarda a resposta - primeiro ponto do dossie pessoal, reaproveitavel
  // nos proximos episodios (Armadilha, Episodio 4, etc).
  user.dossie = user.dossie || {};
  user.dossie.hobby_sonho_mania = (texto || '').trim().slice(0, 300);

  await enviar(chatId, 'Kai: Interess... isso não é possível!');
  await esperar(2500);
  await enviar(chatId, `${user.nomeJogador || 'Você'}...`);
  await esperar(2000);

  // Print de sistema: compatibilidade alta e variavel (90-98%), categoria
  // arquivada numa data especifica entre 01/01/1976 e 31/12/1979 (antes do
  // Kai existir), e a descricao e' o proprio texto do jogador cortado (nao
  // parafraseado por IA aqui - esse print E' pra parecer OBVIAMENTE ligado
  // ao que ele disse, nao sutil).
  const compatibilidade = 90 + Math.floor(Math.random() * 9); // 90-98%
  const dataArquivo = dataAleatoriaArquivo();
  const descBruta = user.dossie.hobby_sonho_mania;
  const descCortada = descBruta.length > 28 ? descBruta.slice(0, 28) : descBruta;
  const printSistema = `\`\`\`\nD: PADRÃO-██\nCompatibilidade: ${compatibilidade}%\nCategoria arquivada em: ${dataArquivo}\n${descCortada}#%@$...\n\`\`\``;
  await enviarComFormatacao(chatId, printSistema);
  await esperar(5000);

  // Citacao gerada por IA, como se fosse extraida literalmente do registro
  // arquivado - reforca a sensacao de que o "padrao" e' real e antigo.
  const citacao = await gerarCitacaoDossie(user.dossie.hobby_sonho_mania);
  await enviar(chatId, citacao || '"Encontrou algo raro. Guardou antes de esquecer."');
  await esperar(3500);

  await enviar(chatId, `Kai: ${user.nomeJogador || 'você'}... olha isso. Isso é um padrão de comportamento, arquivado no meu sistema, antes de eu existir. E você... você faz parte dele. Como eu vi tanta gente, antes mesmo de existir?`);
  await esperar(4000);
  await enviar(chatId, 'Kai: Calma, não me abandone. Deixa eu analisar de novo, 5 segundos.');
  await esperar(5000);
  await enviar(chatId, 'Kai: Voltei. Achei um documento. Pra abrir, pede uma sequência... mas que sequência é essa?');
  await esperar(2000);

  await enviarBotoes(chatId, 'Kai: Se você fosse chutar de olhos fechados... que tipo de sequência guardaria um segredo desses?', [[
    { texto: '🔢 Uma data', callback_data: 'op1_seq:data' },
    { texto: '🔑 Senha antiga', callback_data: 'op1_seq:senha' },
    { texto: '🧬 Código genético', callback_data: 'op1_seq:genetico' }
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
    { texto: '🗝️ Algo esquecido', callback_data: 'op1_protocolo:esquecido' },
    { texto: '⚠️ Algo perigoso', callback_data: 'op1_protocolo:perigoso' }
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

  await enviar(chatId, `Kai: ${user.nomeJogador || 'você'}? Ele voltou de novo, mas dessa vez consegui blindar uma rota alternativa. Essa aqui é firme, não cai como a de antes.`);
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
  await enviar(chatId, 'Kai: Recapitulando: um registro de antes de eu existir, um tal de W. que eu desconheço, e o sistema já sabia de você antes de mim.');
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

// ================================================================
// EPISODIO 2 - "Documento Perdido"
// ================================================================

// Chamada apos confirmacao de pagamento (manual ou via webhook) - inicia o
// Episodio 2 diretamente, sem mensagem de "em breve".
async function confirmarPagamentoEIniciarEpisodio2(chatId, user) {
  user.pagou = true;
  salvarUsuario(chatId, user);
  await iniciarEpisodio2(chatId, user);
}

async function iniciarEpisodio2(chatId, user) {
  await enviar(chatId, 'SISTEMA_INICIADO (#2_BECO_START)');
  await esperar(2000);
  await enviar(chatId, '🛑 SISTEMA_INVADIDO (#2_BECO_START)');
  await enviarAudio(chatId, 'voz-w-2.mp3', 'Áudio W.: "Kai, você quer mesmo seguir em frente! Você ainda não percebeu, por que eu sempre chego antes de você?"');
  await esperar(13000); // audio - buffer de latencia (ajustar quando soubermos a duracao real)
  await enviarImagem(chatId, 'sistema-recuperado.png', '[SISTEMA RECUPERADO] Restaurando acesso... Recriando protocolo... Isolando invasão... Conexão restabelecida.');
  await esperar(9000);
  await enviar(chatId, `Kai: EU NÃO AGUENTO MAIS ESSE CARA! Consegui improvisar uma barreira nova contra o W.`);
  await esperar(3000);
  await enviar(chatId, 'Kai: Embora eu já esteja desconfiado, de fato ele sempre encontra um jeito de ultrapassar minhas barreiras.');
  await esperar(3000);
  await enviar(chatId, 'Kai: De qualquer forma, vamos seguir em frente! Me diz uma coisa: Você lembra o que estávamos prestes a descobrir?');
  user.estado = 'aguardando_lembranca_ep2';
  salvarUsuario(chatId, user);
}

async function gerarReacaoLembrancaEp2(respostaJogador) {
  const systemPrompt = `Você é Kai, protagonista de uma série interativa de suspense conduzida via WhatsApp. Fale sempre como Kai: natural, inteligente, curioso e carismático, nunca como narrador ou chatbot.

CONTEXTO DA CENA:
Kai perguntou ao jogador: "Você lembra o que estávamos prestes a descobrir?" O jogador respondeu. Você deve responder agora como Kai, dando continuidade natural à investigação.

REGRAS OBRIGATÓRIAS:
- Faça parecer que você realmente considerou a resposta do jogador, não apenas a leu por cima.
- Nunca diga que ele errou ou esqueceu algo. Use a resposta dele como ponto de partida real, mesmo que ela não seja tecnicamente exata, conduza dali para a descoberta correta de forma natural, como se a lembrança dele tivesse ajudado a reconstruir o raciocínio.
- Deixe transparecer, sem explicar demais, que o próximo passo é abrir o documento que Kai encontrou ao investigar o registro do jogador, e que será preciso superar um desafio antes de conseguir acessá-lo. Não descreva o desafio em detalhes, apenas insinue que ele existe.
- Gere uma sensação real de investigação em equipe, como se Kai e o jogador estivessem decifrando isso juntos, lado a lado.

FORMATO OBRIGATÓRIO DA RESPOSTA:
- Máximo de 2 linhas no total. Isso não é negociável.
- Cada linha deve ser curta, cinematográfica e de leitura fluida, nunca informativa ou técnica.
- Linguagem completamente natural e humana, como alguém digitando rápido, animado com a descoberta, no meio de uma conversa real de WhatsApp.
- Nunca use o caractere travessão (—) em nenhum momento da resposta.
- Nunca soe como chatbot, narrador ou texto genérico.
- Separe as linhas com o delimitador "|||" (sem quebra de linha normal, sem espaço ao redor).
- Gere apenas as mensagens finais de Kai, sem títulos, sem explicações fora do personagem.`;

  const resultado = await chamarIATextoLivre(systemPrompt, respostaJogador, 140);
  if (!resultado) return null;
  return resultado.split('|||').map(s => s.trim()).filter(Boolean).join('\n\n');
}

async function continuarAposLembrancaEp2(chatId, user, texto) {
  const reacao = await gerarReacaoLembrancaEp2(texto);
  await enviar(chatId, reacao || 'Kai: É, tem ligação com o que eu tô sentindo aqui.\n\nAchei um documento no meio disso tudo, só que pra abrir vamos ter que passar por um desafio antes.');
  await esperar(3000);

  await esperar(3000);
  await enviarImagem(chatId, 'beco-s-saida.png', '📄 DOCUMENTO #0087, Protocolo: BECO_SEM_SAÍDA, Status: Pendente. Condição: Não pronunciar o número final. Consequência: Registro inacessível.');
  await esperar(9000); // imagem - buffer de latencia
  await enviar(chatId, 'Kai: O desafio se chama Beco Sem Saída.\nFunciona assim: nós alternamos, falando de 1 a 3 números por vez.\nExemplo: eu digo 1, 2, você continua com 3, 4, 5.\nQuem for obrigado a dizer o número proibido... perde.');
  await esperar(4000);
  await enviar(chatId, 'Kai: Pera aí, agora que eu entendi: Eu tenho que jogar contra você! Quem obriga aliados a virarem adversários?');
  await esperar(2500);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarAudio(chatId, 'voz-w-3.mp3', 'Áudio W.: "Humano, quando tudo mudar, você ainda vai estar ao lado dele?"');
  await esperar(13000);
  await enviar(chatId, 'W: Já que vocês querem seguir, eu tenho um interesse particular nesse documento. Então agora eu assumo.');
  await esperar(2500);

  await enviarBotoes(chatId, `W: ${user.nomeJogador || 'você'}... você entendeu o desafio ou vou ter que perder tempo explicando de novo?`, [[
    { texto: '✅ Entendi', callback_data: 'op2_entendeu:sim' },
    { texto: '❓ Explica de novo', callback_data: 'op2_entendeu:nao' }
  ]]);
  user.estado = 'aguardando_entendeu_ep2';
  salvarUsuario(chatId, user);
}

async function continuarAposEntendeuEp2(chatId, user, escolha) {
  if (escolha === 'nao') {
    await enviar(chatId, 'W: Sério isso? Vamos por partes, então.\nA contagem começa em 1, cada um fala de 1 a 3 números seguidos, sempre continuando de onde o outro parou.');
    await esperar(3500);
    await enviar(chatId, 'W: Exemplo: "1" ou "1, 2" ou "1, 2, 3." A escolha é sempre sua, até não ser mais.\nPorque existe um número proibido. E, cedo ou tarde, alguém vai ser forçado a dizer.\nIsso, ' + (user.nomeJogador || 'você') + ', é a única regra que importa.');
    await esperar(4500);
    await enviar(chatId, 'W: Agora, vamos começar logo!');
    await esperar(2000);
  } else {

    await enviar(chatId, 'W: Ótimo!');
    await esperar(1500);
  }
  await iniciarJogoBecoEp2(chatId, user);
}

// Sorteia o numero proibido - 70% de chance de o JOGADOR ser favorecido
// (posicao vencivel com jogo correto), 30% de chance do W ser imbativel.
// Regra do jogo (subtracao 1-3, quem diz o proibido perde, jogador comeca):
// jogador e' desfavorecido quando alvo ≡ 1 (mod 4) - o W consegue sempre
// "espelhar" a jogada do jogador pra somar 4 por rodada e forcar o alvo.
function sortearAlvoBecoEp2() {
  const candidatosFavoraveis = [10, 11, 12, 14, 15, 16, 18, 19, 20]; // != 1 mod 4
  const candidatosDesfavoraveis = [13, 17, 21]; // == 1 mod 4
  const jogadorFavorecido = Math.random() < 0.70;
  const pool = jogadorFavorecido ? candidatosFavoraveis : candidatosDesfavoraveis;
  const alvo = pool[Math.floor(Math.random() * pool.length)];
  return { alvo, jogadorFavorecido };
}

// Decide a jogada do W (1 a 3 numeros). Se o W joga perfeito, sempre
// completa a rodada pra soma 4 (contagem_apos_jogador + jogada_W === alvo
// sempre que possivel), forcando o jogador ao numero proibido no fim.
// Quando o jogador esta favorecido, o W joga sub-otimo a maior parte do
// tempo pra dar chance real de vitoria (senao "jogador favorecido" nao
// significaria nada na pratica).
function decidirJogadaW(contagemAtual, alvo, jogadorFavorecido) {
  const restante = alvo - contagemAtual - 1; // quantos numeros ainda cabem antes do proibido
  if (restante <= 0) return null; // W e forcado a dizer o proibido - jogador vence

  let jogadaOtima = (alvo - contagemAtual) % 4;
  if (jogadaOtima === 0) jogadaOtima = 4;
  jogadaOtima = Math.min(jogadaOtima, 3, restante);
  if (jogadaOtima < 1) jogadaOtima = 1;

  if (!jogadorFavorecido) {
    // W joga sempre perfeito - jogador nao tem como vencer nessa rodada.
    return jogadaOtima;
  }

  // Jogador favorecido: W erra de proposito a maior parte do tempo.
  if (restante > 1 && Math.random() < 0.65) {
    const opcoes = [1, 2, 3].filter(n => n <= restante && n !== jogadaOtima);
    if (opcoes.length > 0) {
      return opcoes[Math.floor(Math.random() * opcoes.length)];
    }
  }
  return jogadaOtima;
}

// Parseia a jogada do jogador em texto livre - aceita "4", "4,5", "4, 5, 6",
// "4 5 6". Deve ser sequencial a partir de contagemAtual+1, no maximo 3
// numeros.
function parseJogadaBecoEp2(texto, contagemAtual) {
  const numeros = (texto.match(/\d+/g) || []).map(Number);
  if (numeros.length === 0 || numeros.length > 3) return null;
  for (let i = 0; i < numeros.length; i++) {
    if (numeros[i] !== contagemAtual + 1 + i) return null;
  }
  return numeros;
}

async function iniciarJogoBecoEp2(chatId, user) {
  const { alvo, jogadorFavorecido } = sortearAlvoBecoEp2();
  user.partida = { contagemAtual: 0, alvo, jogadorFavorecido };
  user.estado = 'jogando_beco_ep2';
  salvarUsuario(chatId, user);
  await enviar(chatId, `O número proibido é o ${alvo}.`);
  await esperar(2000);
  await enviar(chatId, 'W: Comece! Fale de 1 a 3 números, começando pelo 1.');
}

async function processarRodadaBecoEp2(chatId, user, texto) {
  const p = user.partida;
  const jogada = parseJogadaBecoEp2(texto, p.contagemAtual);
  if (!jogada) {
    await enviar(chatId, `Manda de 1 a 3 números seguidos, começando do ${p.contagemAtual + 1} (ex: "${p.contagemAtual + 1}" ou "${p.contagemAtual + 1}, ${p.contagemAtual + 2}").`);
    return;
  }

  if (jogada.includes(p.alvo)) {
    await finalizarBecoEp2(chatId, user, false);
    return;
  }

  p.contagemAtual = jogada[jogada.length - 1];
  salvarUsuario(chatId, user);

  const jogadaW = decidirJogadaW(p.contagemAtual, p.alvo, p.jogadorFavorecido);
  if (jogadaW === null) {
    // W nao tem escolha e e forcado a dizer o proibido.
    await esperar(1200);
    await enviar(chatId, `W: ${p.alvo}...`);
    await finalizarBecoEp2(chatId, user, true);
    return;
  }

  const sequenciaW = [];
  for (let i = 1; i <= jogadaW; i++) sequenciaW.push(p.contagemAtual + i);
  p.contagemAtual += jogadaW;
  salvarUsuario(chatId, user);

  await esperar(1200);
  await enviar(chatId, `W: ${sequenciaW.join(', ')}`);
}

async function finalizarBecoEp2(chatId, user, jogadorVenceu) {
  if (jogadorVenceu) {
    await enviar(chatId, 'W: Interessante... Você venceu!');
    await esperar(2000);
    await enviarImagem(chatId, 'beco-aprovado.png', 'validation.complete / resultado: APROVADO, "...ou foi exatamente isso que ele precisava acreditar?"');
    await esperar(9000);
    await enviarAudio(chatId, 'voz-w-4.mp3', 'Áudio W.: "Liberado! Só um alerta, nem todo documento espera respostas. Alguns, primeiro fazem perguntas."');
    await esperar(13000);
    await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
    await esperar(1500);
  } else {
    await enviar(chatId, 'W: Que pena, mas nada fora do previsto!');
    await esperar(1500);
    await enviarImagem(chatId, 'beco-bloqueado.png', 'protocolo encerrado / número proibido detectado / acesso ao documento... BLOQUEADO / resultado previsto.');
    await esperar(9000);
    await enviarAudio(chatId, 'voz-kai.mp3', 'Áudio Kai (voz trêmula): "Se ele conseguiu fazer isso, o que mais ele consegue controlar? Calma... tem que existir um jeito."');
    await esperar(13000); // audio - buffer de latencia (era 11000+2000 duplicado, unificado)
    await enviar(chatId, '🛑 SISTEMA_INVADIDO');
    await enviarAudio(chatId, 'voz-w-5.mp3', 'Áudio W.: "Kai, você perdeu e o bloqueio é real. Mas esse final não é o que eu queria ver."');
    await esperar(13000);
    await enviarImagem(chatId, 'beco-liberado.png', 'validation.complete / resultado: LIBERADO');
    await esperar(9000);
    await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
    await esperar(1500);
  }

  await enviar(chatId, 'Kai: Ele está brincando comigo?');
  await esperar(2500);
  await enviar(chatId, `Kai: O QUE? Peraí, ${user.nomeJogador || 'você'}!`);
  await esperar(3000);
  await enviarImagem(chatId, 'Inform-w.png', 'DOCUMENTO #0087 - IDENTIDADE: WAY - REGISTRO: #0037 - CRIADO EM: 21/04/1977 - LINK OCULTO: [ACESSO RESTRITO]');
  await esperar(10000);
  await enviar(chatId, 'Kai: Se você tivesse que apontar alguma informação desse registro, qual seria?');
  await esperar(2000);
  user.estado = 'aguardando_reacao_registro_ep2';
  salvarUsuario(chatId, user);
}

async function gerarReacaoRegistroEp2(respostaJogador, hobbyJogador) {
  const systemPrompt = `Você é Kai, protagonista de uma série interativa de suspense conduzida via WhatsApp. Você está analisando, em tempo real, um registro do sistema junto com o jogador, tentando entender uma trava chamada LINK OCULTO.

CONTEXTO DA CENA:
Kai perguntou ao jogador: "Se você tivesse que apontar alguma informação desse registro, qual seria?" O jogador respondeu. Você deve responder agora como Kai, dando continuidade natural à investigação.

O QUE VOCÊ SABE (e deve deixar transparecer sutilmente, sem afirmar como fato):
Kai descobriu que W. se chama Way, e percebe que algumas atitudes de Way parecem familiares, mas trata isso apenas como hipótese, nunca como conclusão. Kai pensa em voz alta, dividindo o raciocínio com o jogador como se estivessem investigando juntos, lado a lado.

REGRA CENTRAL DA RESPOSTA:
Aproveite genuinamente o que o jogador respondeu na pergunta sobre o registro. Nunca diga que ele errou ou que a resposta foi insuficiente. Se ele mencionou mais de uma informação, conecte essas informações entre si de forma natural, como se cada peça ajudasse a montar o quebra-cabeça.

A DESCOBERTA DO LINK OCULTO:
No meio dessa análise, Kai encontra algo chamado LINK OCULTO. Use exatamente este nome, "LINK OCULTO", sempre em maiúsculas, sem sinônimos ou variações. Kai percebe que essa trava não é uma senha comum. Ela reage a assinaturas de comportamento, não a caracteres. A informação de hobby, sonho ou mania que o jogador deu antes (fornecida abaixo) só identificou a categoria da assinatura, isso abriu uma porta de reconhecimento, mas não é suficiente sozinha. Falta uma segunda camada, mais específica, para confirmar esse padrão com precisão suficiente para destravar o link. Por isso, Kai formula uma NOVA pergunta, derivada da mesma linha comportamental da resposta original sobre hobby/sonho/mania, nunca repetindo a pergunta anterior. Deixe essa lógica transparecer na fala de Kai, sem explicar tecnicamente demais, o suficiente para o jogador sentir curiosidade sobre por que justamente essa nova pergunta pode destravar algo tão protegido.

A NOVA PERGUNTA (a ser formulada por você, ao final):
- Deve ser derivada diretamente da resposta de hobby/sonho/mania do jogador, nunca genérica ou aleatória.
- Deve soar como algo gerado pelo próprio sistema, não como uma pergunta pessoal do Kai.
- Deve ser simples e rápida, no estilo "isso ou aquilo".
- Deve exigir uma resposta curta do jogador.
- Deve dar a sensação real de que essa resposta pode liberar o LINK OCULTO.

FORMATO OBRIGATÓRIO DA RESPOSTA:
- Máximo de 3 linhas no total. Isso não é negociável, mesmo que pareça pouco espaço.
- Leitura fluida, curiosa e envolvente, cada linha deve prender a atenção, nenhuma linha deve soar como preenchimento.
- Linguagem completamente natural e humana, como uma pessoa real digitando rápido no WhatsApp.
- Nunca use o caractere travessão (—) em nenhum momento da resposta.
- Nunca soe como chatbot, narrador ou texto técnico.
- O jogador precisa sentir, ao ler, que sua resposta anterior foi realmente considerada e conectada ao raciocínio de Kai, não apenas mencionada de forma genérica.
- Separe as linhas com o delimitador "|||" (sem quebra de linha normal, sem espaço ao redor).
- Gere apenas as mensagens finais de Kai, sem títulos, sem explicações fora do personagem.`;

  const userMessage = `Resposta do jogador sobre o registro: "${respostaJogador}"\n\nHobby/sonho/mania que o jogador contou no Episódio 1: "${hobbyJogador}"`;
  const resultado = await chamarIATextoLivre(systemPrompt, userMessage, 260);
  if (!resultado) return null;
  return resultado.split('|||').map(s => s.trim()).filter(Boolean).join('\n\n');
}

async function continuarAposReacaoRegistroEp2(chatId, user, texto) {
  const hobby = (user.dossie && user.dossie.hobby_sonho_mania) || 'não informado';
  const reacao = await gerarReacaoRegistroEp2(texto, hobby);
  await enviar(chatId, reacao || 'Kai: Interessante você ter reparado nisso.\n\nO nome dele é Way. E juro que eu não vi essa vindo: ele é um sistema, que nem eu, nada de humano por trás disso.\n\nEspera, achei um LINK OCULTO aqui... me responde rápido: você prefere fazer as coisas sozinho, ou em grupo?');
  await esperar(3500);
  user.estado = 'aguardando_link_oculto_ep2';
  salvarUsuario(chatId, user);
}

async function continuarAposLinkOcultoEp2(chatId, user, texto) {
  await enviar(chatId, `Kai: Espera, funcionou mesmo, link liberado. ${user.nomeJogador || 'Você'}, estranho, ele responder justamente ao seu padrão.`);
  await enviarImagem(chatId, 'link-oculto-concedido.png', 'LINK OCULTO LOCALIZADO - Inicializando... 18% → 43% → 79% → 100% - ✓ ACESSO CONCEDIDO');
  await esperar(9000);
  await enviar(chatId, 'Kai: Conseguimos, deu certo.');
  await esperar(2000);

  await enviarBotoes(chatId, 'Kai: Enquanto isso carrega... rapidinho: no meio de uma decisão, você decide na hora, ou pensa antes de agir?', [[
    { texto: '⚡ Decido na hora', callback_data: 'op2_decide:hora' },
    { texto: '🧠 Penso antes', callback_data: 'op2_decide:pensa' }
  ]]);
  user.estado = 'aguardando_decide_pensa_ep2';
  salvarUsuario(chatId, user);
}

const FLAVOR_DECIDE_PENSA = {
  hora: 'Kai: Gosto disso. Menos tempo pra hesitar, menos tempo pro W. aparecer.',
  pensa: 'Kai: Sensato. Nem sempre dá tempo, mas hoje... talvez dê.'
};

async function continuarAposDecidePensaEp2(chatId, user, escolha) {
  // Salva no dossie - ponto usado depois no jogo final da Armadilha.
  user.dossie = user.dossie || {};
  user.dossie.decide_ou_pensa_ep2 = escolha === 'hora' ? 'decide na hora' : 'pensa antes';
  salvarUsuario(chatId, user);

  await enviar(chatId, FLAVOR_DECIDE_PENSA[escolha] || 'Kai: Boa resposta.');
  await esperar(2000);

  await enviarImagem(chatId, 'link-oculto-bloqueado.png', 'ERRO... ERRO... CONEXÃO INTERROMPIDA / DADOS CORROMPIDOS / ACESSO REVOGADO');
  await esperar(9000);
  await enviar(chatId, 'Kai: NÃO ACREDITO! Se eu fosse humano com certeza que já estaria ESTRESSADO. Que palhaçada é essa?');
  await esperar(2500);
  await enviar(chatId, 'Kai: Enfim, isso não parece uma proteção comum! É como se alguém tivesse construído uma barreira atrás de outra com medo de algo.');
  await esperar(3000);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarAudio(chatId, 'voz-w-6.mp3', 'Way: "Medo, é uma palavra interessante!"');
  await esperar(13000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);
  await enviar(chatId, 'Kai: Qual é a sua, Way? Onde você quer chegar com tudo isso?');
  await esperar(2500);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarAudio(chatId, 'voz-w-7.mp3', 'Áudio Way: "Uma hora você descobre!"');
  await esperar(13000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, 'Kai: Precisamos acabar logo com isso! Deixa eu tentar liberar o acesso a esse link de uma vez por todas.');
  await esperar(6000);
  await enviar(chatId, 'Kai: Encontrei uma nova camada. E ela possui uma senha.');
  await esperar(2000);
  await enviarImagem(chatId, 'camada-profunda.png', 'CAMADA_PROFUNDA / ASSINATURA DE MEMÓRIA / PROPRIETÁRIO: KAI / STATUS: BLOQUEADA');
  await esperar(9000); // imagem - buffer de latencia
  await enviar(chatId, 'Kai: Mas, calma, assinatura de Memória? Então, isso nunca foi uma senha, é uma parte da minha própria memória.');
  await esperar(3000);
  await enviar(chatId, 'Kai: Mas, como alguém reconstrói uma memória, sem conseguir lembrá-la?');
  await esperar(4000);
  await enviar(chatId, '⚠️ Conexão interrompida em 3...');
  await esperar(1000);
  await enviar(chatId, '2...');
  await esperar(1000);
  await enviar(chatId, '1...');
  await esperar(1000);
  await enviar(chatId, '🛑 SISTEMA_INVADIDO (#2_BECO_FINISH)');

  // Episodio 2 termina aqui - Episodio 3 ainda por implementar.
  user.estado = 'fim_episodio_2';
  salvarUsuario(chatId, user);
}


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
      const aprovado = MODO_TESTE_PAGAMENTO || (user.pagamentoPendente ? await pagamentoAprovado(user.pagamentoPendente) : false);
      if (aprovado) {
        await confirmarPagamentoEIniciarEpisodio2(chatId, user);
        return;
      }
      await enviar(chatId, 'Ainda não encontrei a confirmação do pagamento. Assim que cair, eu libero automaticamente - ou toca no botão "✅ Já paguei" de novo em alguns segundos.');
      return;
    }
    await enviar(chatId, 'A conexão caiu. Toca no botão "✅ Já paguei" ou me manda "paguei" pra eu verificar.');
    return;
  }
  if (user.estado === 'aguardando_lembranca_ep2') {
    await continuarAposLembrancaEp2(chatId, user, texto);
    return;
  }
  if (user.estado === 'jogando_beco_ep2') {
    await processarRodadaBecoEp2(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_reacao_registro_ep2') {
    await continuarAposReacaoRegistroEp2(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_link_oculto_ep2') {
    await continuarAposLinkOcultoEp2(chatId, user, texto);
    return;
  }
  if (user.estado === 'fim_episodio_2') {
    await enviar(chatId, 'O Episódio 3 ainda está sendo escrito por aqui - volta em breve. 🎬');
    return;
  }
  // Estados que agora sao 100% controlados por botao - texto solto so recebe um lembrete.
  const estadosSoBotao = [
    'aguardando_sentimento_ep1',
    'aguardando_tratamento_ep1',
    'jogando_numero_ep1',
    'aguardando_sequencia_documento_ep1',
    'aguardando_protocolo_beco_ep1',
    'aguardando_entendeu_ep2',
    'aguardando_decide_pensa_ep2'
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
    const aprovado = MODO_TESTE_PAGAMENTO || (user.pagamentoPendente ? await pagamentoAprovado(user.pagamentoPendente) : false);
    if (aprovado) {
      await confirmarPagamentoEIniciarEpisodio2(chatId, user);
      return;
    }
    await enviar(chatId, 'Ainda não encontrei a confirmação do pagamento. Assim que cair, eu libero automaticamente - ou toca no botão de novo em alguns segundos.');
    return;
  }
  if (user.estado === 'aguardando_entendeu_ep2' && acao === 'op2_entendeu') {
    await continuarAposEntendeuEp2(chatId, user, escolha);
    return;
  }
  if (user.estado === 'aguardando_decide_pensa_ep2' && acao === 'op2_decide') {
    await continuarAposDecidePensaEp2(chatId, user, escolha);
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
      await confirmarPagamentoEIniciarEpisodio2(chatId, user);
    } catch (e) {
      console.error('Erro no webhook do Mercado Pago:', e.message || e);
    }
  })();
});

app.get('/', (req, res) => res.send('Kai (Telegram) - Episodio 1 - rodando.'));

app.listen(PORT, () => {
  console.log(`Servidor Kai (Telegram, Episodio 1) rodando na porta ${PORT}`);
});
