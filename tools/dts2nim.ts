// Takes an input ts file, converts types in final scope to Nim and outputs Nim file to stdout

// Conversion rules:
// - Constructors become newClassname()
// - $ becomes "zz"
// - Groups of two or more underscores become single underscores
// - Underscores at the start of a symbol become "z"
// - Nim reserved words (only "type" "end" "from" "when" currently) get x-prefixed

import ts = require("typescript")
import util = require("util")
let commander = require("commander")
let error = require('commander.js-error')

commander
	.version("0.0.1")
	.option('-q, --quiet', 'Suppress warnings')
	.option('--debugPrefix [prefix]', 'Print additional information for symbols starting with...')
	.option('--debugVerbose', 'Dump entire object when printing debug information')
	.arguments("<file>")
	.parse(process.argv)

if (commander.args.length < 1)
	error("No file specified")

if (commander.args.length > 1)
	error("Too many files specified, at the moment the limit is 1")

let program = ts.createProgram(commander.args, {})

let sourceFiles = program.getSourceFiles()

if (sourceFiles.length <= 1)
	error("File not found")

let typeChecker = program.getTypeChecker()

console.log("# Generated by dts2nim script")
console.log("# Source files:")
for (let sourceFile of sourceFiles) {
	console.log("#     " + sourceFile.fileName)
}

console.log()
console.log("when not defined(js) and not defined(Nimdoc):")
console.log("  {.error: \"This module only works on the JavaScript platform\".}")
console.log()

// Support

let blacklist : {[key:string] : boolean} = {} // TODO: Could I just use Set()?
for (let key of ["class:NodeList", "class:Array", "class:ArrayConstructor",
	"field:Element.webkitRequestFullScreen", "field:HTMLVideoElement.webkitEnterFullscreen",
	"field:HTMLVideoElement.webkitExitFullscreen"])
	blacklist[key] = true
function blacklisted(nspace:string, name:string) : boolean {
	return blacklist[name] || blacklist[nspace + ":" + name]
}

// Assume enum is a bitfield, print all relevant bits.
// If "tight", assume enum values are exact values, not masks.
function enumBitstring(Enum, value:number, tight = false) : string {
	let result = ""
	for (let key in Enum) {
		let bit = Enum[key]
		if (typeof bit != "number" || !bit) continue
		let masked = value&bit
		if (tight ? (masked==bit) : masked) {
			if (result) result += "+"
			result += key
		}
	}
	return result
}

// Are all bits in b set in a?
function hasBit(a:number, b:number) { return (a&b)==b }

function capitalizeFirstLetter(str:string) : string {
	return str.charAt(0).toUpperCase() + str.slice(1)
}

let reserved : {[name:string] : boolean} = {}
for (let name of ["addr", "and", "as", "asm", "atomic", "bind", "block", "break", "case", "cast",
	"concept", "const", "continue", "converter", "defer", "discard", "distinct", "div", "do",
	"elif", "else", "end", "enum", "except", "export", "finally", "for", "from", "func", "generic",
	"if", "import", "in", "include", "interface", "is", "isnot", "iterator", "let", "macro",
	"method", "mixin", "mod", "nil", "not", "notin", "object", "of", "or", "out", "proc", "ptr",
	"raise", "ref", "return", "shl", "shr", "static", "template", "try", "tuple", "type", "using",
	"var", "when", "while", "with", "without", "xor", "yield"])
	reserved[name] = true

// Convert TypeScript identifier to legal Nim identifier
// FIXME: Leaves open possibility of collisions
function identifierScrub(id:string) : string {
	id = id
		.replace(/_{2,}/, "_")
		.replace(/\$/, "zz")
	if (id[0] == '_')
		id = "z" + capitalizeFirstLetter(id.slice(1))
	if (reserved[id])
		id = "x" + capitalizeFirstLetter(id.slice(1))
	return id
}

function needIdentifierScrub(id:string) : boolean {
	return id != identifierScrub(id)
}

// Print the symbol that goes inside the quotes for an importc or importcpp
function importIdentifier(id:string) : string {
	return id
		.replace(/\$/, "$$$$")
}

// Print {.importc.} with possible symbol correction
function importDirective(id:string, cpp:boolean = false) : string {
	return "importc" + (cpp?"pp":"") + (id != identifierScrub(id) ? ":\"" + importIdentifier(id) + "\"" : "")
}

function arrayFilter<T>(x: T) : T[] {
	return x != null ? [x] : []
}

function concatAll<T>(x:T[][]) : T[] {
	return [].concat.apply([], x)
}

// Exceptions

// This is needed to work around an issue in Typescript's ES5 generator
class CustomError extends Error {
	constructor(message:string) {
		super()
		this.message = message
	}
}

// Raised on Typescript type the converter script doesn't know how to convert
class UnusableType extends CustomError {
	constructor(public type: ts.Type) {
		super("Cannot represent type: " + typeChecker.typeToString(type))
	}
}

class GenConstructFail extends CustomError {	
}

// Generator classes

// There is a series of Gen types which represent type items and know how to convert them to strings.
// There is also a vendor (a factory) which knows how to create the Gen types given TypeScript objects.
// The Gen constructors should take "pre-digested" data and do very little. Error checking should be
// done in the vendor, not in the Gen.
// If output types other than Nim are at some point supported, the gens will need to be subclassed,
// and the vendor may or may not need to be significantly subclassed.

interface GenVendor {
	typeGen(tsType: ts.Type)
}

interface Gen {
	declString() : string

	depends() : string[] // TODO: Return a Gen[]
	dependKey(): string  // Return the key you are described by in a dependency graph, or null
}

function allDepends(gens: Gen[]) : string[] {
	return concatAll( gens.map( x => x.depends() ) )
}

function genJoin(a:Gen[], joiner:string) {
	return a.map(g => g.declString()).join(joiner)
}

function decls(a: Gen[])  { return genJoin(a, "\n") }
function params(a: Gen[]) { return genJoin(a, ", ") }

function genJoinPrefixed(a:Gen[], prefix:string) {
	return a.map(g => prefix + g.declString()).join("")
}

interface TypeGen extends Gen {
	typeString() : string
}

class IdentifierGen {
	constructor(public name:string, public type: TypeGen) {}

	depends()   { return arrayFilter(this.type.dependKey()) }
	dependKey() { return this.name } // FIXME: Could variables live without these?
}

class VariableGen extends IdentifierGen implements Gen {
	declString() : string {
		return `var ${identifierScrub(this.name)}* {.${importDirective(this.name)}, nodecl.}: `
		     + this.type.typeString()
	}
}

class ParameterGen extends IdentifierGen implements Gen {
	declString() : string {
		return `${identifierScrub(this.name)}: ${this.type.typeString()}`
	}
}

class FieldGen extends IdentifierGen implements Gen {
	declString() : string {
		return `${identifierScrub(this.name)}*`
		     + (needIdentifierScrub(this.name) ? ` {.importc:"${importIdentifier(this.name)}".}` : "")
		     + `: ${this.type.typeString()}`
	}	
}

class SignatureGen implements Gen {
	owner: ClassGen
	constructor(public name: string, public params:ParameterGen[], public returnType: TypeGen) {}
	declString() : string {
		let fullParams = (this.owner ? [new ParameterGen("self", this.owner)] : []) 
		               .concat( this.params )
		return `proc ${identifierScrub(this.name)}*(${params(fullParams)}) : `
		     + this.returnType.typeString()
			 + ` {.${importDirective(this.name, !!this.owner)}.}`
	}

	depends() {
		return allDepends( this.params )
			   .concat( arrayFilter(this.returnType.dependKey()) )
	}
	dependKey() { return this.name }
}

class ConstructorGen implements Gen {
	owner: ClassGen // Set by ClassGen.init
	constructor(public params:ParameterGen[]) {}
	declString() : string {
		let scrubbed = identifierScrub(this.owner.name)
		let name = "new" + capitalizeFirstLetter(scrubbed)
		// Note: params.length check is to work around a bug which is fixed in newest Nim beta
		return `proc ${name}*(${params(this.params)}) : ${scrubbed}`
			 + ` {.importcpp:"new ${importIdentifier(this.owner.name)}${this.params.length?"(@)":""}".}`
	}

	depends() {
		return allDepends( this.params )
	}
	dependKey() { return null } // Constructors dont stand alone
}

class LiteralTypeGen implements TypeGen {
	constructor(public literal: string) {}

	declString() : string { throw new Error("Tried to emit a declaration for a a core type") }
	typeString() { return this.literal }

	depends() { return [] }
	dependKey() { return null }
}

class ClassGen implements TypeGen { // TODO: Make name optional?
	// Inherit may be null. "abstract" refers to a class that can be inherited from but not instantiated.
	inherit: ClassGen
	fields: FieldGen[]
	constructors: ConstructorGen[]
	methods: SignatureGen[]
	inited: boolean
	invalid: boolean
	constructor(public name: string, public abstract: boolean) {}
	init(inherit:ClassGen, fields: FieldGen[], constructors: ConstructorGen[], methods: SignatureGen[]) {
		this.inherit = inherit
		this.fields = fields
		this.constructors = constructors
		this.methods = methods
		this.inited = true
		for (let constructor of constructors)
			constructor.owner = this
		for (let method of methods)
			method.owner = this
	}

	declString() : string {
		let fullMethods: Gen[] = this.methods
		if (!this.abstract)
			fullMethods = (this.constructors as Gen[]).concat( fullMethods )

		return `type ${identifierScrub(this.name)}* {.${importDirective(this.name)}.} = ref object of `
		     + (this.inherit ? identifierScrub(this.inherit.name) : "RootObj")
			 + genJoinPrefixed(this.fields, "\n    ")
		     + genJoinPrefixed(fullMethods, "\n")
	}
	typeString() {
		return this.name
	}

	depends() {
		return concatAll(
			[this.fields, this.constructors, this.methods].map( x => allDepends(x) )
		).concat( this.inherit ? [this.inherit.dependKey()] : [] )
	}
	dependKey() { return this.name }
}

function chainHasField(gen:ClassGen, name:string) : boolean {
	if (!gen)
		return false
	for(let field of gen.fields)
		if (field.name == name)
			return true
	return chainHasField(gen.inherit, name)
}

class GenVendor {
	classes: {[name:string] : ClassGen}
	constructor() {
		this.classes = {}
	}

	variableGen(sym: ts.Symbol, tsType: ts.Type) : VariableGen {
		try {
			if (blacklisted("variable", sym.name))
				throw new GenConstructFail(`Refusing to translate blacklisted variable ${sym.name}`)

			return new VariableGen(sym.name, vendor.typeGen(tsType))
			
		} catch (_e) {
			let e:{} = _e
			if (e instanceof UnusableType)
				throw new GenConstructFail("Could not translate variable "+sym.name+" because couldn't translate type "+typeChecker.typeToString(e.type))
			else
				throw e
		}
	}

	paramsGen(syms: ts.Symbol[]) : ParameterGen[] {
		return syms.map(sym =>
			new ParameterGen(sym.name, this.typeGen(typeChecker.getTypeOfSymbolAtLocation(sym, sourceFile.endOfFileToken)))
		)
	}

	signatureGen(sym: ts.Symbol, callSignature: ts.Signature) : SignatureGen {
		return new SignatureGen(sym.name, this.paramsGen(callSignature.getParameters()), this.typeGen(callSignature.getReturnType()))
	}

	functionGen(sym: ts.Symbol, tsType: ts.Type) : SignatureGen[] {
		if (blacklisted("variable", sym.name))
			throw new GenConstructFail(`Refusing to translate blacklisted function ${sym.name}`)

		let result: SignatureGen[] = []
		let counter = 0
		for (let callSignature of tsType.getCallSignatures()) {
			try {
				counter++
				result.push( this.signatureGen(sym, callSignature) )
			} catch (e) {
				if (e instanceof UnusableType)
					warn(`Could not translate function ${sym.name}`
						+ (counter > 0 ? `, call signature #${counter}` : "")
						+ ` because tried to translate ${typeChecker.typeToString(tsType)}`
						+ ` but couldn't translate type ${typeChecker.typeToString(e.type)}`
					)
				else
					throw e
			}
		}
		return result
	}

	classGen(sym: ts.Symbol, abstract = false) : TypeGen {
		let name = sym.name
		let already = this.classes[name]
		if (already) { // FIXME: will freak out on "prototype"
			if (already.invalid)
				throw new GenConstructFail("Tried to reuse unbuildable type") // FIXME: Should be an UnusableType
			return already
		}

		if (blacklisted("class", name))
			throw new GenConstructFail("Refusing to translate blacklisted class " + name)

		let result = new ClassGen(name, abstract)
		this.classes[name] = result

		try {
			let fields : FieldGen[] = []
			let methods: SignatureGen[] = []
			let constructors: ConstructorGen[] = []
			let foundConstructors = 0

			// Get superclass
			// Neither "heritageClauses" nor "types" are exposed. CHEAT: 
			let heritageClauses = (<any>sym.declarations[0]).heritageClauses
			let inherit:ClassGen = null

			if (heritageClauses) {
				let inheritSymbol = typeChecker.getSymbolAtLocation(heritageClauses[0].types[0].expression)

				let inheritName = inheritSymbol.name

				inherit = vendor.classGen(inheritSymbol) as ClassGen // FIXME: NO NO NO NO NO USING "AS" IS NOT OK HERE NO

				if (!inherit.inited) // FIXME: THIS WILL SOMETIMES OCCUR IN LEGITIMATE CIRCUMSTANCES. FIX WHEN MUTUAL RECURSION BECOMES ALLOWED
					throw new GenConstructFail(`${name} is mutually recursive with its ancestor ${inheritName} in a confusing way`)
			}

			// Iterate over class members
			// Public interface for SymbolTable lets you look up keys but not iterate them. CHEAT:
			for (let key in <any>sym.members) {
				let member = sym.members[key]
				let memberType = typeChecker.getTypeOfSymbolAtLocation(member, sourceFile.endOfFileToken)
				
				// Member is a constructor
				if (hasBit(member.flags, ts.SymbolFlags.Constructor)) {
					for (let declaration of member.declarations) {
						foundConstructors++
						try {
							constructors.push( new ConstructorGen( 
								// Parameters exist on Delcaration but are not publicly exposed. CHEAT:
								this.paramsGen( (declaration as any).parameters.map(node => node.symbol) )
							) )
						} catch (_e) {
							let e:{} = _e
							if (e instanceof UnusableType)
								warn(`Could not translate constructor #${foundConstructors} on class ${name}`
								   + ` because couldn't translate type ${typeChecker.typeToString(e.type)}`
								)
							else
								throw _e
						}
					}

				// Member is a field
				} else if (hasBit(member.flags, ts.SymbolFlags.Property)) {
					try {
						if (blacklisted("field", name + "." + member.name))
							warn(`Refusing to translate blacklisted field ${member.name} of class ${name}`)
						else if (!chainHasField(inherit, member.name))
							fields.push(new FieldGen(member.name, this.typeGen(memberType)))
					} catch (_e) {
						let e:{} = _e
						if (e instanceof UnusableType)
							warn(`Could not translate property ${member.name} on class ${name}`
							  +  `because couldn't translate type ${typeChecker.typeToString(e.type)}`
							)
						else
							throw _e
					}

				// Member is a method
				} else if (hasBit(member.flags, ts.SymbolFlags.Method)) {
					if (blacklisted("field", name + "." + member.name)) {
						warn(`Refusing to translate blacklisted method ${member.name} of class ${name}`)
					} else {
						let counter = 0
						for (let callSignature of memberType.getCallSignatures()) {
							try {
								counter++
								methods.push( this.signatureGen(member, callSignature) )
							} catch (_e) {
								let e:{} = _e
								if (e instanceof UnusableType)
									warn(`Could not translate method ${sym.name} on class $name}`
										+ (counter > 0 ? `, call signature #${counter}` : "")
										+ ` because tried to translate ${typeChecker.typeToString(memberType)}`
										+ ` but couldn't translate type ${typeChecker.typeToString(e.type)}`
										)
								else
									throw _e
							}
						}
					}

				// Member is unsupported
				} else {
					warn(`Could not figure out how to translate member ${member.name} of class ${sym.name}`)
				}
			}

			// Get constructor
			// FIXME: Produces garbage on inherited constructors
			if (!foundConstructors) {
				if (inherit && inherit.constructors) {
					for (let constructor of inherit.constructors) {
						constructors.push(new ConstructorGen( constructor.params ))
					}
				} else {
					constructors.push(new ConstructorGen([]))
				}
			}

			result.init(inherit, fields, constructors, methods)
			return result
		} catch (e) {
			result.invalid = true
			throw e
		}
	}

	typeGen(tsType: ts.Type) : TypeGen {
		if (tsType.flags & ts.TypeFlags.Number) // FIXME: Numberlike?
			return new LiteralTypeGen("float")
		if (tsType.flags & ts.TypeFlags.String) // FIXME: Stringlike?
			return new LiteralTypeGen("cstring")
		if (tsType.flags & ts.TypeFlags.Void)
			return new LiteralTypeGen("void")
		if (tsType.flags & ts.TypeFlags.Boolean)
			return new LiteralTypeGen("bool")
		if ((tsType.flags & ts.TypeFlags.Class) && tsType.symbol)
			return this.classGen(tsType.symbol)
		throw new UnusableType(tsType)
	}
}

// Process input

let vendor = new GenVendor()

// Prints to stderr, suppressed if -q option given
let warn = commander.quiet ? function (...X) {} : console.warn.bind(console)

// Prefix `prefix` to every line of `string`, starting at line `startAtLine`
function linePrefix(str:string, prefix:string, startAtLine = 0) : string {
	let ary = str.split("\n")
	for (let idx in ary) {
		if (+idx >= startAtLine)
			ary[idx] = prefix + ary[idx]
	}
	return ary.join("\n")
}

// Return a string containing a commented-out string representation of an object,
// for tacking onto the end of an existing comment line
function debugVerboseEpilogue(obj:any) : string {
	if (!commander.debugVerbose)
		return ""
	return ", " + linePrefix(util.inspect(obj), "#         ", 1)
}

// Emit symbols

let sourceFile = sourceFiles[sourceFiles.length-1]
let generators : Gen[] = []

for (let sym of typeChecker.getSymbolsInScope(sourceFile.endOfFileToken, 0xFFFFFFFF)) {
	let type = typeChecker.getTypeOfSymbolAtLocation(sym, sourceFile.endOfFileToken)
	
	// Handle --debugPrefix command
	if (commander.debugPrefix && sym.name.substr(0, commander.debugPrefix.length) == commander.debugPrefix)
		console.log("\n# " + sym.name + ": " + typeChecker.typeToString(type) +
			"\n#     Node:" + enumBitstring(ts.SymbolFlags, sym.flags, true) +
			debugVerboseEpilogue(sym) +
			"\n#     Type:" + enumBitstring(ts.TypeFlags, type.flags, true) +
			debugVerboseEpilogue(type)
		)

	// Variable
	try {
		// Class
		if (hasBit(sym.flags, ts.SymbolFlags.Class)) {
			generators.push( vendor.classGen(type.symbol) )

		// Interface
		} else if (hasBit(sym.flags, ts.SymbolFlags.Interface)) {
			generators.push( vendor.classGen(sym, true) )

		} else if (hasBit(sym.flags, ts.SymbolFlags.BlockScopedVariable) || hasBit(sym.flags, ts.SymbolFlags.FunctionScopedVariable)) {
			generators.push( vendor.variableGen(sym, type) )

		// Function
		} else if (hasBit(sym.flags, ts.SymbolFlags.Function)) {
			generators = generators.concat( vendor.functionGen(sym, type) )

		// Unsupported
		} else {
			warn("Could not figure out how to translate symbol", sym.name, ":",
					typeChecker.typeToString(type))
		}
	} catch (_e) {
		let e:{} = _e
		if (e instanceof GenConstructFail)
			warn(e.message)
		else
			throw e
	}
}

// We now have a list of all symbols in alphabetical order. We need to sort them in order of
// relative dependency, and if any of the symbols are mutually recursive types we need to know that
// too. The tarjan algorithm (strongly connected components, reverse topological sort) does both
let graphlib = require("graphlib")
let dependencies = new graphlib.Graph()
for (let gen of generators) {
	let key = gen.dependKey()
	dependencies.setNode(key, gen)
	for (let dep of gen.depends())
		dependencies.setEdge(key, dep)
}

//for(let group of graphlib.alg.tarjan(dependencies))
//	console.log(group, dependencies.node(group[0]) != null)

let groupedGenerators : Gen[][] =
	graphlib.alg.tarjan(dependencies)
	.map( scc => scc.map( id => dependencies.node(id) ) )

let sortedGenerators : Gen[] = []
for (let group of groupedGenerators) {
	if (group.length > 1)
		warn("Can't translate mutually recursive types, so ignoring: "
		   + (group.map(x => x.dependKey())).join(", ")) // This is a misuse of dependKey
	else if (group[0]) // TODO: Delete nodes that depend on nonexistent things
		sortedGenerators.push(group[0])
}

console.log( decls(sortedGenerators) )
