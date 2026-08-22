#include <iostream>
namespace outer::inner { int value=19; }
int main(){ std::cout<<outer::inner::value<<"\n"; }
